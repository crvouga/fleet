"""Open the shared Oh My Pi conversation, or pass native automation arguments."""
import os
from pathlib import Path
import shlex
import sys


def request(original, entry):
    if not original:
        return ["tmux", "new-session", "-A", "-s", "coding", entry, "--continue"]
    args = shlex.split(original)
    if not args or args[0] not in ("omp", "fleet-code"):
        raise ValueError("SSH accepts Oh My Pi requests; send work to the coding conversation.")
    return [entry, *args[1:]]


if __name__ == "__main__":
    try:
        os.umask(0o077)
        os.chdir(Path.home())
        command = request(os.environ.get("SSH_ORIGINAL_COMMAND", ""), os.environ["FLEET_CODE_ENTRY"])
        os.execvp(command[0], command)
    except (OSError, ValueError) as error:
        print(f"fleet-code: {error}", file=sys.stderr)
        sys.exit(2)
