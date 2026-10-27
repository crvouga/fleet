"""Download the installer image and write it to a USB disk.

Pure Python on purpose: Windows has no dd, and the wizard must not depend on
curl, bash, or anything else being installed. Every step states what it
expects with `invariant`, so a corrupt download, a short write, or a bad
read-back stops the program with the values needed to diagnose it.
"""
import errno
import hashlib
import http.client
import os
import re
import socket
import ssl
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import bootstrap  # noqa: F401
import decide

CHUNK = 4 * 1024 * 1024
SECTOR = 4096  # a multiple of both 512 and 4096 byte sectors
SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")
TIMEOUT = 30


class Cancelled(Exception):
    """The person pressed cancel. Nothing is left half written that the next run cannot redo."""


def _noop(*_args):
    return None


def transient(error):
    """Retry network interruptions, never disk errors or integrity failures."""
    if isinstance(error, decide.ReleaseChanging):
        return True
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (408, 429) or 500 <= error.code <= 599
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, BaseException) and transient(error.reason)
    if isinstance(error, socket.gaierror):
        return error.errno == socket.EAI_AGAIN
    if isinstance(error, (TimeoutError, ConnectionError, http.client.IncompleteRead)):
        return True
    if isinstance(error, ssl.SSLError) and not isinstance(error, ssl.SSLCertVerificationError):
        # An EOF or reset inside TLS is an interrupted connection; a certificate failure is not.
        return "EOF" in str(error).upper() or "RESET" in str(error).upper()
    if isinstance(error, OSError):
        return error.errno in (errno.ECONNRESET, errno.ECONNREFUSED, errno.ETIMEDOUT, errno.ENETUNREACH, errno.EHOSTUNREACH)
    return error.__cause__ is not None and transient(error.__cause__)


PUBLISH_WAIT = 15 * 60  # a release publication uploads several GiB of parts


def retry(action, note=_noop, cancel=None, publish_wait=None, attempts=3):
    """Network interruptions get `attempts` tries. A release that is being published
    gets as long as a publication takes, polled every 30 seconds."""
    publish_wait = PUBLISH_WAIT if publish_wait is None else publish_wait
    attempt, started = 0, time.monotonic()
    while True:
        if cancel and cancel():
            raise Cancelled()
        try:
            return action()
        except decide.ReleaseChanging as changing:
            if publish_wait <= 0:
                raise  # the caller restarts from a fresh checksum
            if time.monotonic() - started >= publish_wait:
                decide.invariant(False, "the installer release kept changing while it was downloaded",
                                 "A new release is probably still being published. Wait until the Fleet workflow finishes, then press Try again. Nothing was erased.",
                                 minutes=publish_wait // 60, last=str(changing))
            note("A new installer release is being published. Waiting for it to finish before downloading; this can take several minutes.")
            until = time.monotonic() + min(30, max(publish_wait / 10, 0.05))
            while time.monotonic() < until:
                if cancel and cancel():
                    raise Cancelled()
                time.sleep(0.1)
            continue
        except (RuntimeError, OSError, http.client.IncompleteRead) as exc:
            attempt += 1
            if attempt >= attempts or not transient(exc):
                raise
            note(f"The network interrupted the download. Retrying automatically ({attempt + 1}/3).")
            until = time.monotonic() + 0.5 * attempt
            while time.monotonic() < until:
                if cancel and cancel():
                    raise Cancelled()
                time.sleep(0.1)


def open_url(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(request, timeout=TIMEOUT)


def parse_checksum(text):
    words = text.split()
    decide.invariant(bool(words) and SHA_RE.match(words[0]) is not None, "the checksum file is not a sha256", "The release is broken. Re-run the Fleet workflow so it publishes fleet-installer.iso.sha256.", got=text[:80])
    return words[0].lower()


def fetch_checksum(url):
    try:
        with open_url(url) as reply:
            return parse_checksum(reply.read(4096).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"could not download the checksum from {url}: {exc}") from exc


def probe(url):
    """Return (error or None, total size or None) without downloading the image."""
    try:
        with open_url(url, {"Range": "bytes=0-0"}) as reply:
            reply.read(1)
            total = None
            span = reply.headers.get("Content-Range", "")
            match = re.search(r"/(\d+)$", span)
            if match:
                total = int(match.group(1))
            elif reply.headers.get("Content-Length") and getattr(reply, "status", None) in (None, 200):
                total = int(reply.headers["Content-Length"])
            return None, total
    except (urllib.error.URLError, OSError) as exc:
        try:
            return None, decide.installer_parts(url)["size"]
        except decide.Invariant as broken:
            # A manifest this installer cannot read (usually a newer release format): say so, never crash the scan.
            return f"{broken.what}. {broken.fix}", None
        except (urllib.error.URLError, OSError, RuntimeError) as multipart_error:
            return f"{getattr(exc, 'reason', exc)}; multipart release: {multipart_error}", None


def sha256_of(path, progress=_noop, cancel=None):
    digest = hashlib.sha256()
    size = os.path.getsize(path)
    done = 0
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            if cancel and cancel():
                raise Cancelled()
            digest.update(block)
            done += len(block)
            progress(done, size)
    return digest.hexdigest()


def download(url, dest, expected_sha256, progress=_noop, cancel=None, retry_note=_noop):
    # A release that changes mid-download is not retried here: the expected checksum
    # itself is stale. The caller fetches the checksum again (see server.run_job).
    return retry(lambda: _download_once(url, dest, expected_sha256, progress, cancel), retry_note, cancel, publish_wait=0)


def _download_once(url, dest, expected_sha256, progress=_noop, cancel=None):
    """Fetch url to dest. dest only ever holds a complete, verified image."""
    expected = expected_sha256.lower()
    decide.invariant(SHA_RE.match(expected) is not None, "download was given a malformed sha256", sha=expected_sha256)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if cancel and cancel():
        raise Cancelled()
    if dest.is_file() and sha256_of(dest, cancel=cancel) == expected:
        progress(dest.stat().st_size, dest.stat().st_size)
        return dest
    sweep_partials(dest)
    # Multiple wizard windows must never share a partial download.
    fd, name = tempfile.mkstemp(prefix=dest.name + ".", suffix=".partial", dir=dest.parent)
    os.close(fd)
    staged = Path(name)
    digest = hashlib.sha256()
    written = 0
    try:
        try:
            reply = open_url(url)
        except (urllib.error.URLError, OSError) as exc:
            if transient(exc):
                raise
            reply = None
        with open(staged, "wb") as out:
            if reply is None:
                def check_cancel():
                    if cancel and cancel():
                        raise Cancelled()
                written, assembled_sha = decide.stream_installer_parts(url, out, progress, check_cancel)
            else:
                with reply:
                    total = int(reply.headers.get("Content-Length") or 0)
                    while True:
                        block = reply.read(CHUNK)
                        if not block:
                            break
                        if cancel and cancel():
                            raise Cancelled()
                        out.write(block)
                        digest.update(block)
                        written += len(block)
                        progress(written, total)
                    if total and written < total:
                        raise http.client.IncompleteRead(b"", total - written)
                assembled_sha = digest.hexdigest()
            out.flush()
            os.fsync(out.fileno())
    except (urllib.error.URLError, OSError, http.client.IncompleteRead) as exc:
        staged.unlink(missing_ok=True)
        raise RuntimeError(f"the download from {url} failed after {written} bytes: {exc}") from exc
    except Cancelled:
        staged.unlink(missing_ok=True)
        raise
    except (decide.Invariant, RuntimeError):
        staged.unlink(missing_ok=True)
        raise
    try:
        decide.invariant(assembled_sha == expected, "the downloaded installer does not match its checksum",
                         "Run the wizard again. If it repeats, the release asset and its .sha256 disagree: re-run the Fleet workflow.",
                         want=expected, got=assembled_sha, bytes=written)
        with open(staged, "rb") as check:
            head = check.read(decide.ISO_MAGIC_OFFSET + 5)
        decide.invariant(decide.looks_like_iso(head), "the downloaded file matches its checksum but is not an ISO9660 image",
                         "The release asset is wrong. Re-run the Fleet workflow so it publishes a real fleet-installer.iso.", bytes=written)
    except decide.Invariant:
        staged.unlink(missing_ok=True)
        raise
    os.replace(staged, dest)
    decide.invariant(dest.stat().st_size == written, "the installer on disk is the wrong size", file=str(dest), want=written)
    return dest


PARTIAL_STALE = 60 * 60  # a download in progress writes every few seconds


def sweep_partials(dest):
    """Delete partial downloads that nothing has written for an hour: a window that was
    closed or killed mid-download. Another window's live download is never touched."""
    now = time.time()
    for old in Path(dest).parent.glob(Path(dest).name + ".*.partial"):
        try:
            if now - old.stat().st_mtime > PARTIAL_STALE:
                old.unlink()
                decide.log(f"removed an abandoned partial download {old}")
        except OSError as exc:
            decide.log(f"could not remove the partial download {old}: {exc}", "WARN")


def padded(size):
    return (size + SECTOR - 1) // SECTOR * SECTOR


def check_capacity(size, capacity):
    decide.invariant(size > 0, "refusing to write an empty image", size=size)
    decide.invariant(capacity >= padded(size), "the USB disk is smaller than the installer",
                     "Use a USB disk of at least the size shown in the wizard.", capacity=capacity, image=size, required=padded(size))


def write_image(iso, target, capacity, expected_sha256, progress=_noop, cancel=None):
    """Write iso to target (a raw disk, or any file in tests), sync it, then
    read it back and prove the bytes are the ones that were verified."""
    iso = Path(iso)
    size = iso.stat().st_size
    check_capacity(size, capacity)
    decide.invariant(SHA_RE.match(expected_sha256) is not None, "write_image was given a malformed sha256", sha=expected_sha256)
    flags = os.O_RDWR | getattr(os, "O_BINARY", 0)
    fd = os.open(target, flags)
    written = 0
    try:
        with open(iso, "rb") as source:
            while written < size:
                if cancel and cancel():
                    raise Cancelled()
                block = source.read(CHUNK)
                decide.invariant(block != b"", "the image ended early while writing", wrote=written, want=size)
                if len(block) % SECTOR:
                    block = block + b"\0" * (padded(len(block)) - len(block))
                count = os.write(fd, block)
                decide.invariant(count == len(block), "the disk accepted a short write", wrote=count, asked=len(block), at=written)
                written += min(len(block), size - written)
                progress(written, size)
        os.fsync(fd)
        digest = hashlib.sha256()
        os.lseek(fd, 0, os.SEEK_SET)
        remaining = size
        while remaining:
            if cancel and cancel():
                raise Cancelled()
            want = min(CHUNK, padded(remaining))
            block = os.read(fd, want)
            decide.invariant(len(block) > 0, "the disk returned nothing while reading back", missing=remaining)
            take = min(len(block), remaining)
            digest.update(block[:take])
            remaining -= take
            progress(size - remaining, size)
    finally:
        os.close(fd)
    decide.invariant(digest.hexdigest() == expected_sha256.lower(), "the USB disk does not hold the installer after writing",
                     "The USB disk or its port is faulty. Try another USB disk or port.", want=expected_sha256, got=digest.hexdigest())
    return size


def cache_dir(os_name=None):
    os_name = os_name or decide.current_os()
    override = os.environ.get("FLEET_CACHE")
    if override:
        return Path(override)
    if os_name == "Windows":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "fleet-installer"
    if os_name == "Darwin":
        return Path.home() / "Library" / "Caches" / "fleet-installer"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "fleet-installer"


# Python 3.12.4+ gives mkdtemp directories on Windows an ACL for SYSTEM,
# Administrators and OWNER RIGHTS. A file the elevated helper creates inside is
# owned by Administrators, so OWNER RIGHTS then locks the unelevated wizard out
# of the helper's progress and result (issue #140). Name this user's SID instead;
# every file created inside inherits it, whoever owns the file.
WINDOWS_SCRATCH_SDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})"
TOKEN_QUERY = 0x0008
TOKEN_USER = 1
ERROR_ALREADY_EXISTS = 183


def scratch_dir(prefix):
    if os.name == "nt":
        return _windows_scratch_dir(prefix)
    path = Path(tempfile.mkdtemp(prefix=prefix))
    os.chmod(path, 0o700)
    return path


def _win32():
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p]
    kernel.CreateDirectoryW.restype = wintypes.BOOL
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.GetTokenInformation.restype = wintypes.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.ULONG)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    return ctypes, wintypes, kernel, advapi


def windows_user_sid():
    """The string SID of the user this process runs as, e.g. S-1-5-21-…-1001."""
    ctypes, wintypes, kernel, advapi = _win32()
    token = wintypes.HANDLE()
    decide.invariant(advapi.OpenProcessToken(kernel.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)),
                     "could not read this Windows user's identity", error=ctypes.get_last_error())
    try:
        size = wintypes.DWORD(0)
        advapi.GetTokenInformation(token, TOKEN_USER, None, 0, ctypes.byref(size))  # only sizes the buffer
        decide.invariant(size.value > 0, "Windows did not size this user's identity", error=ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(size.value)
        decide.invariant(advapi.GetTokenInformation(token, TOKEN_USER, buffer, size, ctypes.byref(size)),
                         "could not read this Windows user's identity", error=ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]  # TOKEN_USER starts with User.Sid
        text = wintypes.LPWSTR()
        decide.invariant(advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)),
                         "could not format this Windows user's identity", error=ctypes.get_last_error())
        try:
            value = text.value
        finally:
            kernel.LocalFree(text)
    finally:
        kernel.CloseHandle(token)
    decide.invariant(bool(re.fullmatch(r"S-1(-\d+)+", value or "")), "Windows returned an unusable user SID", sid=value)
    return value


def _windows_scratch_dir(prefix, sid=None):
    ctypes, wintypes, kernel, advapi = _win32()
    sddl = WINDOWS_SCRATCH_SDDL.format(sid=sid or windows_user_sid())

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p), ("bInheritHandle", wintypes.BOOL)]

    descriptor = ctypes.c_void_p()
    decide.invariant(advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None),
                     "could not build the private folder permissions", error=ctypes.get_last_error(), sddl=sddl)
    try:
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor.value, False)
        base = Path(tempfile.gettempdir())
        for _attempt in range(100):
            path = base / f"{prefix}{os.urandom(6).hex()}"
            if kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
                return path
            error = ctypes.get_last_error()
            decide.invariant(error == ERROR_ALREADY_EXISTS, "could not create the installer's private working folder",
                             "Check that the temporary folder exists and has free space, then try again.", folder=str(base), error=error)
        decide.invariant(False, "could not find a free name for the installer's working folder", folder=str(base))
    finally:
        kernel.LocalFree(descriptor)
