"""Exercise the built OMP launcher without accounts, prompts or inference."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def check(launcher, prompt, home):
    # Never inherit an operator's API keys, credential paths or agent state.
    env = {"HOME": home, "PATH": os.environ["PATH"], "TERM": "dumb"}
    command = [launcher, "--append-system-prompt", prompt]

    def run(*args, input=None):
        result = subprocess.run([*command, *args], cwd=home, env=env,
                                input=input, text=True, capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError(f"OMP exited {result.returncode}: {result.stderr[-2000:]}")
        return result

    expected = {
        "modelRoles": {"default": "openai-codex/*"},
        "browser.enabled": False,
        "browser.relay": False,
        "retry.modelFallback": False,
        "startup.checkUpdate": False,
        "marketplace.autoUpdate": "off",
    }
    for key, value in expected.items():
        result = run("config", "get", key, "--json")
        actual = json.loads(result.stdout)["value"]
        if actual != value:
            raise RuntimeError(f"OMP ignored fleet setting {key}: {actual!r}")

    # A default-provider launcher must still accept a fully qualified model
    # from another provider. get_state never starts a model turn.
    result = run("--mode", "rpc", "--no-session", "--no-extensions", "--no-lsp",
                 "--model", "anthropic/claude-sonnet-4-5",
                 input='{"id":"inspect","type":"get_state"}\n')
    responses = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    state = next(item for item in responses if item.get("id") == "inspect")
    if not state.get("success") or state["data"]["model"]["provider"] != "anthropic":
        raise RuntimeError(f"Explicit provider selection failed: {state!r}")

    print("OMP settings and explicit provider selection passed without inference")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="fleet-coding-smoke-") as temporary:
        check(str(Path(sys.argv[1]).resolve()), str(Path(sys.argv[2]).resolve()), temporary)
