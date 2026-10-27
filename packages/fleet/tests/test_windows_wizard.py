#!/usr/bin/env python3
"""What the wizard and the downloaded script do on Windows that can be checked on any computer:
the elevation command line (a PyInstaller exe under a path with spaces), the Win32 calls behind
the prompt and the disk lock, stream encodings, and the choice of a working Python. The Windows
API is replaced by stand-ins; nothing here needs Windows or administrator rights."""

import ast
import ctypes
import importlib.util
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "wizard"))
from test_windows_firmware import FakeFn  # noqa: E402

import decide  # noqa: E402  (wizard/bootstrap.py puts scripts/ on the path)
import elevate  # noqa: E402
import imaging  # noqa: E402
import leases  # noqa: E402
import main as wizard_main  # noqa: E402


def command_line_to_argv(text):
    """The rules of CommandLineToArgvW / the Microsoft C runtime for the part after the program name."""
    args, current, in_quotes, started, i = [], [], False, False, 0
    while i < len(text):
        char = text[i]
        if char == "\\":
            run = 0
            while i < len(text) and text[i] == "\\":
                run += 1
                i += 1
            started = True
            if i < len(text) and text[i] == '"':
                current.append("\\" * (run // 2))
                if run % 2:
                    current.append('"')
                    i += 1
                # an even run leaves the quote to be processed as a delimiter
            else:
                current.append("\\" * run)
            continue
        if char == '"':
            in_quotes = not in_quotes
            started = True
        elif char in " \t" and not in_quotes:
            if started:
                args.append("".join(current))
                current, started = [], False
        else:
            current.append(char)
            started = True
        i += 1
    if started:
        args.append("".join(current))
    return args


class ElevationCommandTest(unittest.TestCase):
    EXE = "C:\\Users\\Jo Smith\\Downloads\\fleet-installer-windows-x64.exe"
    JOB = "C:\\Users\\Jo Smith\\AppData\\Local\\Temp\\fleet-job-a1b2c3"

    def test_a_path_with_spaces_goes_in_its_own_field_and_the_arguments_read_back_unchanged(self):
        for job in (self.JOB, self.JOB + "\\", "D:\\Temp\\two  spaces\\and\"quote", "C:\\x\\y"):
            with self.subTest(job=job):
                program, parameters = elevate.shell_execute_parameters([self.EXE, "--helper", job])
                self.assertEqual(program, self.EXE, "lpFile is a path, never quoted")
                self.assertEqual(command_line_to_argv(parameters), ["--helper", job])

    def test_the_reference_parser_agrees_with_known_cases(self):
        self.assertEqual(command_line_to_argv('a "b c" d\\\\ "e\\\\"'), ["a", "b c", "d\\\\", "e\\"])
        self.assertEqual(command_line_to_argv(r'"a\"b" c'), ['a"b', "c"])

    def test_a_frozen_exe_relaunches_itself_with_the_helper_flag(self):
        with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", self.EXE):
            self.assertEqual(elevate.helper_argv(self.JOB), [self.EXE, "--helper", self.JOB])

    def test_from_source_it_relaunches_main_py(self):
        with mock.patch.object(sys, "frozen", False, create=True):
            argv = elevate.helper_argv("/tmp/job")
        self.assertEqual(argv[0], sys.executable)
        self.assertTrue(argv[1].endswith("main.py") and argv[2:] == ["--helper", "/tmp/job"])


class FakeShell:
    def __init__(self, accept=True):
        self.accept, self.info = accept, None
        self.ShellExecuteExW = FakeFn(self.execute)

    def execute(self, pointer):
        info = pointer._obj
        self.info = {"verb": info.lpVerb, "file": info.lpFile, "parameters": info.lpParameters, "mask": info.fMask, "show": info.nShow, "size": info.cbSize}
        if not self.accept:
            return False
        info.hProcess = 777
        return True


class FakeProcessKernel:
    def __init__(self, waits, code):
        self.waits, self.code, self.closed = list(waits), code, []
        self.WaitForSingleObject = FakeFn(lambda handle, ms: self.waits.pop(0))
        self.GetExitCodeProcess = FakeFn(self.exit_code)
        self.CloseHandle = FakeFn(lambda handle: self.closed.append(handle) or True)

    def exit_code(self, handle, pointer):
        pointer._obj.value = self.code
        return True


class LastErrorMixin:
    """ctypes.get_last_error exists only on Windows; the code calls it while building its arguments."""

    def setUp(self):
        super().setUp()
        patch = mock.patch.object(ctypes, "get_last_error", lambda: 0, create=True)
        patch.start()
        self.addCleanup(patch.stop)


class WindowsPromptTest(LastErrorMixin, unittest.TestCase):
    def start(self, shell, kernel):
        libs = {"shell32": shell, "kernel32": kernel}
        with mock.patch.object(ctypes, "WinDLL", lambda name, **kw: libs[name], create=True):
            return elevate._WindowsProcess([ElevationCommandTest.EXE, "--helper", ElevationCommandTest.JOB])

    def test_the_runas_verb_starts_the_exe_and_its_exit_code_is_read_back(self):
        shell, kernel = FakeShell(), FakeProcessKernel([258, 258, 0], 0)
        process = self.start(shell, kernel)
        self.assertEqual(shell.info["verb"], "runas")
        self.assertEqual(shell.info["file"], ElevationCommandTest.EXE)
        self.assertEqual(command_line_to_argv(shell.info["parameters"]), ["--helper", ElevationCommandTest.JOB])
        self.assertEqual(shell.info["mask"] & 0x40, 0x40, "SEE_MASK_NOCLOSEPROCESS: the handle is needed to wait")
        self.assertEqual(shell.info["mask"] & 0x100, 0x100, "SEE_MASK_NOASYNC")
        self.assertEqual(shell.info["show"], 0)
        self.assertIsNone(process.poll())
        self.assertIsNone(process.poll())
        self.assertEqual(process.poll(), 0)
        self.assertEqual(process.wait(), 0)
        self.assertEqual(kernel.closed, [777])

    def test_a_failing_helper_reports_its_exit_code(self):
        process = self.start(FakeShell(), FakeProcessKernel([0], 1))
        self.assertEqual(process.wait(timeout=5), 1)

    def test_declining_the_prompt_is_a_message_not_a_crash(self):
        with self.assertRaises(elevate.ElevationUnavailable) as caught:
            self.start(FakeShell(accept=False), FakeProcessKernel([], 0))
        self.assertIn("Yes", str(caught.exception))

    def test_a_wait_that_fails_stops_loudly(self):
        process = self.start(FakeShell(), FakeProcessKernel([0xFFFFFFFF], 0))
        with self.assertRaises(decide.Invariant):
            process.poll()

    def test_is_admin_asks_the_shell_and_a_missing_windll_means_not_admin(self):
        shell = mock.Mock()
        shell.shell32.IsUserAnAdmin.return_value = 1
        with mock.patch.object(ctypes, "windll", shell, create=True):
            self.assertTrue(elevate.is_admin("Windows"))
            self.assertTrue(decide.windows_admin())
            shell.shell32.IsUserAnAdmin.return_value = 0
            self.assertFalse(elevate.is_admin("Windows"))
            self.assertFalse(decide.windows_admin())
        if not hasattr(ctypes, "windll"):
            self.assertFalse(elevate.is_admin("Windows"))
            self.assertIsNone(decide.windows_admin(), "unknown is not the same as not administrator")

    def test_the_privilege_prompt_is_chosen_for_windows_unless_already_elevated(self):
        with mock.patch.dict(os.environ, {"FLEET_ELEVATE": ""}), mock.patch.object(elevate, "is_admin", return_value=False):
            self.assertEqual(elevate.mode_for("Windows"), "Windows")
        with mock.patch.dict(os.environ, {"FLEET_ELEVATE": ""}), mock.patch.object(elevate, "is_admin", return_value=True):
            self.assertEqual(elevate.mode_for("Windows"), "none")


class FakeMutexKernel:
    def __init__(self, status):
        self.status, self.released, self.closed, self.names = status, 0, 0, []
        self.CreateMutexW = FakeFn(lambda attrs, owner, name: self.names.append(name) or 55)
        self.WaitForSingleObject = FakeFn(lambda handle, ms: self.status)
        self.ReleaseMutex = FakeFn(self.release)
        self.CloseHandle = FakeFn(self.close)

    def release(self, handle):
        self.released += 1
        return True

    def close(self, handle):
        self.closed += 1
        return True


class DiskLockOnWindowsTest(LastErrorMixin, unittest.TestCase):
    """The lock is a named kernel mutex there; no fcntl, no lock directory."""

    def lease(self, status):
        kernel = FakeMutexKernel(status)
        return kernel, mock.patch.object(ctypes, "WinDLL", lambda name, **kw: kernel, create=True), mock.patch.object(leases.os, "name", "nt")

    def test_acquiring_and_releasing(self):
        kernel, dll, nt = self.lease(0)
        with dll, nt:
            with leases.DeviceLease("\\\\.\\PHYSICALDRIVE0"):
                pass
        self.assertTrue(kernel.names[0].startswith("Global\\FleetInstaller-"))
        self.assertEqual((kernel.released, kernel.closed), (1, 1))

    def test_a_mutex_abandoned_by_a_crashed_helper_is_taken_over(self):
        kernel, dll, nt = self.lease(128)
        with dll, nt, leases.DeviceLease("\\\\.\\PHYSICALDRIVE0"):
            pass
        self.assertEqual(kernel.released, 1)

    def test_a_second_window_is_told_to_wait(self):
        kernel, dll, nt = self.lease(258)
        with dll, nt, self.assertRaises(decide.Invariant) as caught:
            with leases.DeviceLease("\\\\.\\PHYSICALDRIVE0"):
                self.fail("the lease must not be granted")
        self.assertIn("another installer", caught.exception.what)
        self.assertEqual(kernel.closed, 1)

    def test_the_name_is_the_same_for_the_same_disk_and_differs_between_disks(self):
        a, b, c = (leases.DeviceLease(p).name for p in ("\\\\.\\PHYSICALDRIVE0", "\\\\.\\PHYSICALDRIVE0", "\\\\.\\PHYSICALDRIVE1"))
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


class FakeScratchKernel:
    def __init__(self, collisions=0, error=183):
        self.collisions, self.error, self.last_error = collisions, error, 0
        self.created, self.descriptors, self.freed, self.closed = [], [], [], []
        self.CreateDirectoryW = FakeFn(self.create)
        self.LocalFree = FakeFn(lambda pointer: self.freed.append(getattr(pointer, "value", pointer)))
        self.GetCurrentProcess = FakeFn(lambda: -1)
        self.CloseHandle = FakeFn(lambda handle: self.closed.append(getattr(handle, "value", handle)) or True)

    def create(self, path, attributes):
        if self.collisions:
            self.collisions -= 1
            self.last_error = self.error
            return False
        self.descriptors.append(attributes._obj.lpSecurityDescriptor)
        os.mkdir(path)
        self.created.append(path)
        return True


class FakeAdvapi:
    SID = "S-1-5-21-1004336348-1177238915-682003330-1001"

    def __init__(self, kernel):
        self.kernel, self.sddl = kernel, []
        self.ConvertStringSecurityDescriptorToSecurityDescriptorW = FakeFn(self.descriptor)
        self.OpenProcessToken = FakeFn(self.open_token)
        self.GetTokenInformation = FakeFn(self.token_information)
        self.ConvertSidToStringSidW = FakeFn(self.sid_text)

    def descriptor(self, sddl, revision, pointer, size):
        self.sddl.append((sddl, revision))
        pointer._obj.value = 4242
        return True

    def open_token(self, process, access, pointer):
        self.access = access
        pointer._obj.value = 99
        return True

    def token_information(self, token, kind, buffer, length, needed):
        self.kind = kind
        if buffer is None:
            needed._obj.value = 64
            return False
        ctypes.memmove(buffer, ctypes.byref(ctypes.c_void_p(0x5151)), ctypes.sizeof(ctypes.c_void_p))
        return True

    def sid_text(self, sid, pointer):
        self.sid = sid
        pointer._obj.value = self.SID
        return True


class JobFolderOnWindowsTest(unittest.TestCase):
    """Issue #140: the elevated helper's files must stay readable by the unelevated wizard."""

    def libraries(self, kernel):
        advapi = FakeAdvapi(kernel)
        libs = {"kernel32": kernel, "advapi32": advapi}
        dll = mock.patch.object(ctypes, "WinDLL", lambda name, **kw: libs[name], create=True)
        error = mock.patch.object(ctypes, "get_last_error", lambda: kernel.last_error, create=True)
        return advapi, dll, error

    def test_the_folder_names_this_user_by_sid_never_owner_rights(self):
        kernel = FakeScratchKernel()
        advapi, dll, error = self.libraries(kernel)
        with dll, error:
            path = imaging._windows_scratch_dir("fleet-job-", sid=FakeAdvapi.SID)
        self.addCleanup(shutil.rmtree, path, True)
        sddl, revision = advapi.sddl[0]
        self.assertEqual(sddl, f"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{FakeAdvapi.SID})")
        self.assertNotIn(";OW)", sddl)
        self.assertEqual(revision, 1)
        self.assertTrue(path.is_dir() and path.name.startswith("fleet-job-"))
        self.assertEqual(Path(path).parent, Path(tempfile.gettempdir()))
        self.assertEqual(kernel.descriptors, [4242])
        self.assertEqual(kernel.freed, [4242], "the security descriptor is freed")

    def test_a_name_collision_tries_another_name_and_other_errors_stop(self):
        kernel = FakeScratchKernel(collisions=2)
        _advapi, dll, error = self.libraries(kernel)
        with dll, error:
            path = imaging._windows_scratch_dir("fleet-job-", sid=FakeAdvapi.SID)
        self.addCleanup(shutil.rmtree, path, True)
        self.assertEqual(len(kernel.created), 1)
        kernel = FakeScratchKernel(collisions=1, error=5)
        _advapi, dll, error = self.libraries(kernel)
        with dll, error, self.assertRaises(decide.Invariant) as caught:
            imaging._windows_scratch_dir("fleet-job-", sid=FakeAdvapi.SID)
        self.assertIn("private working folder", caught.exception.what)
        self.assertEqual(kernel.freed, [4242])

    def test_the_user_sid_is_read_from_this_process_token(self):
        kernel = FakeScratchKernel()
        advapi, dll, error = self.libraries(kernel)
        with dll, error:
            self.assertEqual(imaging.windows_user_sid(), FakeAdvapi.SID)
        self.assertEqual((advapi.access, advapi.kind, advapi.sid), (imaging.TOKEN_QUERY, imaging.TOKEN_USER, 0x5151))
        self.assertEqual(kernel.closed, [99], "the token handle is closed")

    def test_windows_uses_the_private_folder_and_other_systems_mkdtemp(self):
        with mock.patch.object(imaging.os, "name", "nt"), mock.patch.object(imaging, "_windows_scratch_dir", return_value="made") as made:
            self.assertEqual(imaging.scratch_dir("fleet-job-"), "made")
        made.assert_called_once_with("fleet-job-")
        if os.name != "nt":
            path = imaging.scratch_dir("fleet-job-")
            self.addCleanup(shutil.rmtree, path, True)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)


class StreamTest(unittest.TestCase):
    def strict(self):
        return io.TextIOWrapper(io.BytesIO(), encoding="cp437", errors="strict")

    def test_a_code_page_that_cannot_print_an_ellipsis_does_not_stop_the_wizard(self):
        out, err = self.strict(), self.strict()
        with self.assertRaises(UnicodeEncodeError):
            out.write("Starting the local Fleet installer\u2026")
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", err):
            wizard_main.readable_streams()
            print("Starting the local Fleet installer\u2026", file=sys.stdout)
            print("error in a language Windows speaks: \u4f60\u597d", file=sys.stderr)
        out.flush()

    def test_the_downloaded_script_also_survives_windows_error_text_in_another_language(self):
        out, err = self.strict(), self.strict()
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", err):
            self.assertEqual(decide.main(["help"]), 0)
            decide.say("PowerShell said: Zugriff verweigert \u2013 \u4f60\u597d")
        err.flush()


class NoBareAssertTest(unittest.TestCase):
    def test_python_dash_o_cannot_remove_a_check(self):
        """invariant() is the only way facts are asserted; `assert` disappears under python -O."""
        for path in [ROOT / "scripts" / "decide.py", *sorted((ROOT / "wizard").glob("*.py"))]:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            bare = [node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)]
            self.assertEqual(bare, [], f"{path.name} has a bare assert")

    def test_the_script_has_no_posix_only_import_at_module_level(self):
        tree = ast.parse((ROOT / "scripts" / "decide.py").read_text(encoding="utf-8"))
        top = {alias.name for node in tree.body if isinstance(node, ast.Import) for alias in node.names}
        self.assertFalse(top & {"fcntl", "pwd", "grp", "termios", "resource"}, top & {"fcntl", "pwd", "grp", "termios", "resource"})

    def test_the_wizard_modules_import_fcntl_only_inside_the_posix_branch(self):
        for path in sorted((ROOT / "wizard").glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            top = {alias.name for node in tree.body if isinstance(node, ast.Import) for alias in node.names}
            self.assertNotIn("fcntl", top, path.name)

    def test_decide_runs_under_dash_o(self):
        done = subprocess.run([sys.executable, "-O", "-I", str(ROOT / "scripts" / "decide.py"), "help"], capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("usage: fleet-node.sh", done.stdout)


class LauncherTest(unittest.TestCase):
    """fleet-node.sh must not pick a name that only opens the Microsoft Store."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name)
        for tool in ("mktemp", "sed", "cp", "rm", "dirname", "cat", "bash"):
            found = shutil.which(tool)
            self.assertIsNotNone(found, tool)
            (self.bin / tool).symlink_to(found)

    def stub(self, name, code, exit_code):
        path = self.bin / name
        path.write_text(f"#!/bin/sh\necho '{name}: Python was not found; run without arguments to install from the Microsoft Store.' >&2\nexit {exit_code}\n" if code is None else code)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run_script(self):
        env = {"PATH": str(self.bin), "HOME": self.tmp.name, "FLEET_STATE": str(self.bin / "state")}
        return subprocess.run([str(self.bin / "bash"), str(ROOT / "scripts" / "fleet-node.sh"), "help"], capture_output=True, text=True, env=env, timeout=60)

    def test_a_store_stub_is_skipped_for_the_real_python(self):
        self.stub("python3", None, 9009)
        (self.bin / "python").symlink_to(sys.executable)
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("usage: fleet-node.sh", done.stdout)

    def test_the_py_launcher_is_the_last_resort(self):
        self.stub("python3", None, 9009)
        self.stub("python", None, 9009)
        (self.bin / "py").symlink_to(sys.executable)
        self.assertEqual(self.run_script().returncode, 0)

    def test_only_stubs_means_one_clear_next_line_and_nothing_written(self):
        self.stub("python3", None, 9009)
        self.stub("python", None, 9009)
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertIn("Next: Python 3 is not installed", done.stderr)
        self.assertEqual(done.stderr.count("Next:"), 1)
        self.assertFalse((self.bin / "state").exists())

    def test_python_2_or_an_old_python_3_is_not_accepted(self):
        self.stub("python3", "#!/bin/sh\n[ \"$1\" = -c ] && exit 1\nexit 0\n", 0)
        done = self.run_script()
        self.assertEqual(done.returncode, 1, done.stdout)


if __name__ == "__main__":
    unittest.main()
