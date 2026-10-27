"""Ask the operating system for administrator rights, only when needed.

The wizard's web server never runs privileged. When the person presses the
final button it starts one short-lived helper through the OS's own prompt
(Windows UAC, the macOS password dialog, polkit on Linux). The helper reads a
request file, re-checks everything itself, writes progress and a result, and
exits. Nothing a web page or another local program does can erase a disk
without that prompt appearing.
"""
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

import bootstrap  # noqa: F401
import decide


class ElevationUnavailable(Exception):
    """No way to get administrator rights here. The message says what to run instead."""


def is_admin(os_name):
    if os_name == "Windows":
        try:
            import ctypes
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except (AttributeError, OSError):
            return False
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid) and geteuid() == 0


def launcher_argv():
    """The command that starts this program again."""
    native = Path(__file__).resolve().parent / "launcher"
    if native.is_file():
        return [str(native)]
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, str(Path(__file__).resolve().parent / "main.py")]


def helper_argv(directory):
    return [*launcher_argv(), "--helper", str(directory)]


def mode_for(os_name):
    """How the helper will be started. FLEET_ELEVATE=none runs it as this user
    (tests and machines that are already root)."""
    chosen = os.environ.get("FLEET_ELEVATE", "")
    if chosen:
        decide.invariant(chosen in ("none", "auto"), "FLEET_ELEVATE must be none or auto", value=chosen)
        if chosen == "none":
            return "none"
    if is_admin(os_name):
        return "none"
    return os_name


def applescript_command(argv):
    quoted = " ".join(shlex.quote(part) for part in argv)
    escaped = quoted.replace("\\", "\\\\").replace('"', '\\"')
    return f'do shell script "{escaped}" with administrator privileges'


def shell_execute_parameters(argv):
    """(program, parameters) for ShellExecuteEx. The program path goes in its own field, so a
    path with spaces needs no quotes; everything after it is one command line, quoted by the
    same rules CommandLineToArgvW (and so Python and PyInstaller) read back."""
    return argv[0], subprocess.list2cmdline(argv[1:])


class _Waitable:
    def __init__(self, process, hint=None):
        self.process = process
        self.returncode = None
        self.hint = hint

    def terminate(self):
        """Close a permission prompt that is still open. A helper that already runs as
        root cannot be signalled from here, and is not: it finishes its work."""
        try:
            self.process.terminate()
        except OSError:
            pass

    def poll(self):
        self.returncode = self.process.poll()
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = self.process.wait(timeout=timeout)
        return self.returncode


class _WindowsProcess:
    """ShellExecuteEx with the runas verb: the only way to raise UAC for a child."""

    def __init__(self, argv):
        import ctypes
        from ctypes import wintypes

        class Info(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD), ("fMask", wintypes.ULONG), ("hwnd", wintypes.HWND),
                ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
                ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
                ("dwHotKey", wintypes.DWORD), ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE),
            ]

        self.ctypes = ctypes
        # ctypes otherwise treats HANDLE arguments as 32-bit ints, truncating
        # handles on 64-bit Windows and losing reliable process completion.
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        shell.ShellExecuteExW.argtypes = [ctypes.POINTER(Info)]
        shell.ShellExecuteExW.restype = wintypes.BOOL
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel = kernel
        info = Info()
        info.cbSize = ctypes.sizeof(Info)
        info.fMask = 0x00000040 | 0x00000100  # SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
        info.lpVerb = "runas"
        info.lpFile, info.lpParameters = shell_execute_parameters(argv)
        info.nShow = 0
        if not shell.ShellExecuteExW(ctypes.byref(info)):
            raise ElevationUnavailable("Windows did not start the administrator prompt, or it was refused. Run the installer again and choose Yes on the prompt.")
        self.handle = info.hProcess
        decide.invariant(bool(self.handle), "UAC started a helper without a process handle")
        self.returncode = None

    def poll(self):
        if self.returncode is None:
            status = self.kernel.WaitForSingleObject(self.handle, 0)
            decide.invariant(status in (0, 258), "could not wait for the privileged helper", status=status, error=self.ctypes.get_last_error())
            if status == 0:
                code = self.ctypes.c_ulong()
                decide.invariant(self.kernel.GetExitCodeProcess(self.handle, self.ctypes.byref(code)), "could not read the helper exit code", error=self.ctypes.get_last_error())
                self.returncode = code.value
                self.kernel.CloseHandle(self.handle)
        return self.returncode

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.time() + timeout
        while self.poll() is None:
            if deadline is not None and time.time() > deadline:
                raise subprocess.TimeoutExpired("helper", timeout)
            time.sleep(0.2)
        return self.returncode


def start(os_name, argv):
    """Start argv with administrator rights. Returns an object with poll() and wait()."""
    mode = mode_for(os_name)
    decide.log(f"starting helper mode={mode}")
    # Its own session: closing the terminal or pressing Ctrl+C in it must not kill a
    # helper half way through a disk write (it would skip its own undo).
    detached = {"start_new_session": True}
    if mode == "none":
        return _Waitable(subprocess.Popen(argv, **detached))
    if mode == "Windows":
        return _WindowsProcess(argv)
    if mode == "Darwin":
        return _Waitable(subprocess.Popen(["osascript", "-e", applescript_command(argv)], **detached))
    pkexec = shutil.which("pkexec")
    graphical = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    if pkexec and graphical:
        return _Waitable(subprocess.Popen([pkexec, *argv], **detached))
    sudo = shutil.which("sudo")
    if sudo and subprocess.run([sudo, "-n", "true"], check=False, capture_output=True).returncode == 0:
        return _Waitable(subprocess.Popen([sudo, "-n", *argv], **detached))
    if sudo and sys.stdin is not None and sys.stdin.isatty():
        # Ordinary Linux downloads run in a terminal. Let sudo ask there when
        # there is no desktop polkit agent; no command needs to be retyped. It
        # needs the terminal to ask, so it stays in this session.
        return _Waitable(subprocess.Popen([sudo, "--", *argv]),
                         hint="Type your password in the terminal window this installer was started from.")
    raise ElevationUnavailable("This computer cannot ask for administrator rights from here. Close this window and run: sudo " + " ".join(shlex.quote(p) for p in launcher_argv()))


def read_progress(path, offset):
    """New JSON lines since offset. A torn last line is left for the next read."""
    path = Path(path)
    if not path.is_file():
        return [], offset
    with open(path, "rb") as handle:
        handle.seek(offset)
        data = handle.read()
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    rows = []
    for line in data[:end].splitlines():
        try:
            rows.append(json.loads(line.decode("utf-8")))
        except ValueError:
            rows.append({"step": "log", "message": "(unreadable progress line)"})
    return rows, offset + end + 1
