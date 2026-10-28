import json

# The test script of tests/runner-registration.nix (read with builtins.readFile,
# so it is plain Python that the static guard can compile). It is type checked
# with ty and linted with ruff (F rules) by the NixOS test driver, like any other
# test script: no unused names, no f-strings without a placeholder.
#
# One VM, the real `ci` role, the fleet agent and a fake controller on loopback
# (tests/runner_registration_broker.py). The node has no GitHub App at all.

PORT = 8099
STATE = "/run/fake-controller"
SLOTS = ("slot-1", "slot-2")
CHOSEN = "acme/ci-fixture"
PLACEHOLDER = "https://github.com/fleet-controller/unassigned"


def broker_requests():
    text = machine.succeed(f"cat {STATE}/requests.jsonl")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def registrations(slot):
    return [r for r in broker_requests() if r["path"] == "/v1/runner-registration" and r.get("slot") == slot]


def all_registrations():
    return [r for r in broker_requests() if r["path"] == "/v1/runner-registration"]


def issued_tokens(slot):
    text = machine.succeed(f"cat {STATE}/issued.jsonl")
    return [json.loads(line)["token"] for line in text.splitlines() if line.strip() and json.loads(line)["slot"] == slot]


def set_mode(name, word):
    machine.succeed(f"echo {word} > {STATE}/{name}")


def register_record(slot):
    return json.loads(machine.succeed(f"cat /run/fleet/register/{slot}.json"))


def properties(unit, *names):
    flags = " ".join(f"-p {name}" for name in names)
    shown = machine.succeed(f"systemctl show {unit} {flags}")
    return dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)


def prop(unit, name):
    return properties(unit, name)[name]


def wait_for(description, check, timeout=120):
    def attempt(_last_try):
        return bool(check())

    with machine.nested(description):
        retry(attempt, timeout)


def wait_active(slot, timeout=240):
    machine.wait_until_succeeds(f"systemctl is-active --quiet github-runner-{slot}.service", timeout=timeout)


def wait_record(slot, code, exit_status):
    def recorded():
        status, text = machine.execute(f"cat /run/fleet/register/{slot}.json")
        if status != 0:
            return False
        record = json.loads(text)
        return record["code"] == code and record["exit"] == exit_status

    wait_for(f"{slot} recorded {code} (exit {exit_status})", recorded)


def last_readiness():
    beats = [r for r in broker_requests() if r["path"] == "/v1/heartbeat" and r["status"] == 200]
    return " | ".join(beats[-1]["readiness"] or [])


def report_and_read():
    # One real agent cycle, now: the heartbeat carries the node's readiness issues.
    machine.succeed("fleet-agent once")
    return last_readiness()


def restart_attempt(slot):
    # The unit may refuse to start (that is the point); only the outcome is asserted.
    machine.execute(f"systemctl restart github-runner-{slot}.service")


start_all()
machine.wait_for_unit("multi-user.target")
machine.wait_for_unit("fake-controller.service")
machine.wait_for_unit("fleet-agent.service")
machine.succeed("grep -qx 2 /run/fleet/slot-count")

# ---------------------------------------------------------------- 1. the happy path
# Both slots come up. A slot may lose one race at boot (the agent creates
# node.secret and registers the node while the slot first asks for a token); the
# unit restarts itself, so allow for that and assert only the end state.
for slot in SLOTS:
    wait_active(slot)

node_id = machine.succeed("grep '^machine_id=' /run/fleet/node | cut -d= -f2").strip()
assert len(node_id) == 64, node_id
granted = [r for r in registrations("slot-1") if r["status"] == 200]
assert granted, "the controller never granted slot-1 a token"
assert granted[-1]["node"] == node_id, "the token was requested with another node's credential"
assert granted[-1]["repository"] is False, "the node named a repository: the controller must choose"
assert granted[-1]["key"], "no idempotency key was sent"
assert any(r["path"] == "/v1/heartbeat" and r["status"] == 200 for r in broker_requests()), "the agent never heartbeated"

# The token: root-owned 0600 file in a 0700 directory, the very token the controller issued.
machine.succeed("test \"$(stat -c '%a %U %G' /run/fleet/tokens/slot-1)\" = '600 root root'")
machine.succeed("test \"$(stat -c %a /run/fleet/tokens)\" = 700")
token = machine.succeed("cat /run/fleet/tokens/slot-1").strip()
assert token in issued_tokens("slot-1"), "the token file does not hold a token the controller issued"
# The listener was configured with that token, and told the controller's repository
# through the slot's assignment record (the Runner.Listener wrapper turns the module's
# placeholder URL into https://github.com/<record>; tests/test_node_scripts.py runs that wrapper).
args = machine.succeed("cat /run/fleet/slot-1/configure-args").splitlines()
assert args[args.index("--token") + 1] == token
assert args[args.index("--url") + 1] == PLACEHOLDER
machine.succeed(f"grep -qx {CHOSEN} /run/fleet/assign-used/slot-1")
machine.succeed("test \"$(stat -c %a /run/fleet/assign-used/slot-1)\" = 644")
done = register_record("slot-1")
assert done["code"] == "ok" and done["exit"] == 0, done

# The node never had a GitHub App: no key, no ID, nothing decrypted.
machine.succeed("test ! -e /run/secrets/github-app-key")
machine.succeed("grep -qx 'app_id=' /etc/fleet/runner.conf")
machine.succeed("grep -qF '\"appId\":\"\"' /etc/fleet/bootstrap.json")
# And the token is in no log.
machine.fail(f"journalctl --no-pager -b | grep -F {token}")

# -------------------------------------------------- 2. resource control, as declared
for slot in SLOTS:
    declared = properties(f"github-runner-{slot}.service", "Slice", "CPUWeight", "IOWeight", "TasksMax", "OOMScoreAdjust")
    assert declared == {
        "Slice": "fleet-ci.slice",
        "CPUWeight": "100",
        "IOWeight": "100",
        "TasksMax": "16384",
        "OOMScoreAdjust": "500",
    }, declared

memory = int(machine.succeed("awk '/^MemTotal:/ { print $2 }' /proc/meminfo")) * 1024


def near(actual, percent):
    return abs(actual - memory * percent / 100) <= memory * 2 / 100


slice_limits = properties("fleet-ci.slice", "MemoryHigh", "MemoryMax")
assert near(int(slice_limits["MemoryHigh"]), 88), (slice_limits, memory)
assert near(int(slice_limits["MemoryMax"]), 92), (slice_limits, memory)
# The kernel really holds the slice to it, and the slot lives inside the slice.
group = prop("fleet-ci.slice", "ControlGroup")
assert near(int(machine.succeed(f"cat /sys/fs/cgroup{group}/memory.high")), 88)
assert near(int(machine.succeed(f"cat /sys/fs/cgroup{group}/memory.max")), 92)
assert prop("github-runner-slot-1.service", "ControlGroup").startswith(group + "/")
# CI is sacrificed before the agent: the listener is a 500, the agent a -500.
listener = prop("github-runner-slot-1.service", "MainPID")
assert machine.succeed(f"cat /proc/{listener}/oom_score_adj").strip() == "500"
assert prop("fleet-agent.service", "OOMScoreAdjust") == "-500"
agent = prop("fleet-agent.service", "MainPID")
assert machine.succeed(f"cat /proc/{agent}/oom_score_adj").strip() == "-500"
# The sandbox is intact next to the new controls.
sandbox = properties(
    "github-runner-slot-1.service",
    "NoNewPrivileges", "ProtectSystem", "PrivateTmp", "PrivateUsers", "DynamicUser", "User", "UMask", "Restart",
)
assert sandbox == {
    "NoNewPrivileges": "yes",
    "ProtectSystem": "strict",
    "PrivateTmp": "yes",
    "PrivateUsers": "yes",
    "DynamicUser": "no",
    "User": "slot-1",
    "UMask": "0077",
    "Restart": "always",
}, sandbox

# ------------------------------------------------ 3. version skew: the agent's side
# A controller that answers a heartbeat with no desired document, no credential
# and no maintenance hint is what an older controller sends: the agent copes.
# One that adds fields this node has never heard of is what a newer one sends.
skew_from = len(broker_requests())
for answer in ("minimal", "future", "minimal"):
    set_mode("heartbeat", answer)
    machine.succeed("fleet-agent once")
skewed = [r for r in broker_requests()[skew_from:] if r["path"] == "/v1/heartbeat"]
assert len(skewed) >= 3 and all(r["status"] == 200 for r in skewed), skewed
assert not [r for r in broker_requests() if r["path"] == "/v1/credential/rotate"]

# ------------------------------------------------ 4. an outage: 503 + Retry-After
before = len(registrations("slot-1"))
set_mode("registration", "unavailable")
restart_attempt("slot-1")


def outage_attempts():
    counts = {}
    for request in registrations("slot-1")[before:]:
        if request["status"] == 503:
            counts[request["key"]] = counts.get(request["key"], 0) + 1
    return counts


# One attempt asks three times with one idempotency key, then exits 75 ...
wait_for("one attempt retried with one key", lambda: max(outage_attempts().values(), default=0) >= 3)
wait_record("slot-1", "FLEET_GITHUB_UNAVAILABLE", 75)
machine.fail("systemctl is-active --quiet github-runner-slot-1.service")
machine.succeed("journalctl --no-pager -u github-runner-slot-1.service | grep -F 'status=75'")
# ... and the unit restarts itself (Restart=always) with a new attempt and a new key.
wait_for("slot-1 restarted itself", lambda: int(prop("github-runner-slot-1.service", "NRestarts")) >= 1, 90)
wait_for("a second attempt with its own key", lambda: len(outage_attempts()) >= 2, 90)
assert "FLEET_GITHUB_UNAVAILABLE" in report_and_read()
# The controller recovers; the node is back without anybody touching it.
set_mode("registration", "ok")
wait_active("slot-1", 120)
wait_record("slot-1", "ok", 0)
assert machine.succeed("cat /run/fleet/tokens/slot-1").strip() in issued_tokens("slot-1")

# ---------------------------------------- 5. a refusal: 403 runner_not_allowed
set_mode("registration", "forbidden")
restart_attempt("slot-1")
wait_record("slot-1", "runners_drained", 78)
refusal = register_record("slot-1")
assert "Runner admission is closed" in refusal["message"], refusal
machine.fail("systemctl is-active --quiet github-runner-slot-1.service")
machine.succeed("journalctl --no-pager -u github-runner-slot-1.service | grep -F 'runners_drained'")
machine.succeed("journalctl --no-pager -u github-runner-slot-1.service | grep -F 'status=78'")
text = report_and_read()
assert "runners_drained" in text and "slot-1" in text, text
# It stays down: it keeps asking (Restart=always), it never starts without a token.
asked = len(registrations("slot-1"))
wait_for("slot-1 asks again", lambda: len(registrations("slot-1")) > asked, 90)
machine.fail("systemctl is-active --quiet github-runner-slot-1.service")

# ------------------- 6. a controller that predates the endpoint: 404, clear refusal
set_mode("registration", "notfound")
restart_attempt("slot-1")
wait_record("slot-1", "FLEET_RUNNER_NOT_ALLOWED", 78)
assert "HTTP 404" in register_record("slot-1")["message"]
machine.fail("systemctl is-active --quiet github-runner-slot-1.service")
assert "FLEET_RUNNER_NOT_ALLOWED" in report_and_read()
set_mode("registration", "ok")
restart_attempt("slot-1")
wait_active("slot-1", 120)

# --------------------------------------------- 7. the gate: drained means no registration
machine.succeed("fleet-drain 30")
machine.succeed("test -e /run/fleet/draining")
for slot in SLOTS:
    machine.fail(f"systemctl is-active --quiet github-runner-{slot}.service")
asked = len(all_registrations())
machine.execute("systemctl start github-runner-slot-1.service github-runner-slot-2.service")
machine.sleep(20)  # longer than RestartSec (15s): a unit that ignored the gate would have asked by now
for slot in SLOTS:
    machine.fail(f"systemctl is-active --quiet github-runner-{slot}.service")
assert len(all_registrations()) == asked, "a drained node asked the controller for a registration token"
machine.succeed("fleet-resume")
for slot in SLOTS:
    wait_active(slot, 120)
assert len(all_registrations()) > asked
machine.succeed("test ! -e /run/fleet/draining")
# A withdrawn node (fleet-remove) never registers again until it is reinstalled.
machine.succeed("systemctl stop github-runner-slot-2.service")
machine.succeed("touch /nix/fleet-state/withdrawn")
asked = len(all_registrations())
machine.execute("systemctl start github-runner-slot-2.service")
machine.fail("systemctl is-active --quiet github-runner-slot-2.service")
assert len(all_registrations()) == asked, "a withdrawn node asked for a registration token"
machine.succeed("rm /nix/fleet-state/withdrawn")
machine.succeed("systemctl start github-runner-slot-2.service")
wait_active("slot-2", 120)

# ---------------------------------------- 8. the legacy branch still exists
# A node that holds the old GitHub App key and its IDs registers with GitHub
# itself and never calls the controller. The VM has no GitHub, so an unusable
# key is the observable: the refusal names the key, and the broker sees nothing.
machine.succeed("echo not-an-rsa-private-key > /tmp/legacy-key")
seen = len(broker_requests())
legacy_status, _ = machine.execute(
    f"FLEET_API_URL=http://127.0.0.1:{PORT} FLEET_SLOT=slot-1 FLEET_REGISTER_STATUS=/tmp/legacy-status.json "
    "runner-control register organization acme 123 456 /tmp/legacy-key /tmp/legacy-token"
)
assert legacy_status == 78, legacy_status
assert json.loads(machine.succeed("cat /tmp/legacy-status.json"))["code"] == "FLEET_GITHUB_KEY"
machine.fail("test -e /tmp/legacy-token")
assert len(broker_requests()) == seen, "the legacy branch called the controller"
