"""One privileged writer per device, across independent wizard windows.

OS locks are released on process exit, including crashes. Lock files are kept
so nobody can open a new inode while an older writer still owns the lock.
"""
import hashlib
import os
import stat
import tempfile
from pathlib import Path

import bootstrap  # noqa: F401
import decide


class DeviceLease:
    def __init__(self, path):
        self.name = hashlib.sha256(str(path).encode()).hexdigest()
        self.fd = None
        self.handle = None

    def __enter__(self):
        fix = "Close the other installer window and wait for its disk work to finish, then review again."
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
            self.kernel.CreateMutexW.restype = wintypes.HANDLE
            self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            self.kernel.WaitForSingleObject.restype = wintypes.DWORD
            self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
            self.kernel.ReleaseMutex.restype = wintypes.BOOL
            self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.kernel.CloseHandle.restype = wintypes.BOOL
            self.handle = self.kernel.CreateMutexW(None, False, "Global\\FleetInstaller-" + self.name)
            decide.invariant(bool(self.handle), "could not reserve the disk writer", fix, error=ctypes.get_last_error())
            status = self.kernel.WaitForSingleObject(self.handle, 0)
            if status not in (0, 128):  # acquired, or abandoned by a crashed process
                self.kernel.CloseHandle(self.handle)
                self.handle = None
                decide.invariant(False, "another installer may be writing this disk", fix, status=status)
            return self
        import fcntl
        uid = os.geteuid()
        base = Path("/var/run") if uid == 0 else Path(tempfile.gettempdir())
        directory = base / f"fleet-installer-locks-{uid}"
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        decide.invariant(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700,
                         "the disk lock directory is unsafe", "Remove the unsafe lock directory and run again.", directory=str(directory))
        fd = os.open(directory / self.name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            decide.invariant(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1,
                             "the disk lock file is unsafe", file=self.name)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                decide.invariant(False, "another installer is writing this disk", fix)
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd
        return self

    def __exit__(self, *_args):
        if self.handle:
            self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)
            self.handle = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
