"""Linux Docker acceptance with disposable Moto storage; no production credentials.

Scenarios (each prints its name; a failure prints the docker logs of every
container that scenario started):

  basics            configuration refusal, readiness, schema, graceful stop,
                    restart persistence, fresh restore via S3_* names,
                    rolling hand-over, denied writes
  rolling-deploy    B starts while A takes writes; A stops with SIGTERM
  zero-drain-kill   B becomes healthy, A gets SIGKILL at once
  crash-takeover    A is killed, B starts afterwards and waits out the expiry
  zombie            A is paused past the expiry, B takes over, A resumes
  cold-start        two containers on an empty prefix: exactly one serves
  unsupported       a provider that ignores or denies conditional writes

Every scenario ends with the corruption guard: a fresh container restores the
prefix, passes PRAGMA integrity_check and holds exactly the expected state.

Acknowledged-write bookkeeping uses unique, idempotent `PUT /v1/access/<email>`
calls (admin token); the set of acknowledged emails is compared with
`GET /v1/access`, so "every acknowledged write is present" is set inclusion.

Data-loss bounds the drills assert (see CONFIGURATION.md, "Writer ownership"):
  * hand-over (rolling deploy, with or without SIGKILL of the old instance
    afterwards): no acknowledged write is lost, because the old owner closes its
    write gate before the final sync and releases before the new one serves;
  * killing an owner that is still serving, or any crash: writes acknowledged
    less than one replication window (1 s sync interval plus upload time) before
    the loss may be lost; the drill asserts every write acknowledged at least
    CRASH_LOSS_WINDOW seconds earlier survives.

The Docker flow needs Linux (`--network host`) and moto[server]==5.1.17.
`scripts/check-container-selftest.py` runs the orchestration offline.
"""
import hashlib
import json
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

# The schema version this image must create or upgrade to (packages/fleet-controller/src/db/migrations.ts).
EXPECTED_SCHEMA_VERSION = 3
READ_SCHEMA_VERSION = ("const {Database}=require('bun:sqlite');"
                       "const db=new Database(process.env.FLEET_DATABASE_PATH,{readonly:true});"
                       "process.stdout.write(String(db.query('PRAGMA user_version').get().user_version))")
READ_INTEGRITY = ("const {Database}=require('bun:sqlite');"
                  "const db=new Database(process.env.FLEET_DATABASE_PATH,{readonly:true});"
                  "process.stdout.write(db.query('PRAGMA integrity_check').get().integrity_check)")

# Ownership timing the containers run with: small values keep the drills short.
RENEW_SECONDS = 1
EXPIRE_SECONDS = 15
# The replication window: 1 s sync interval plus upload time, with margin.
CRASH_LOSS_WINDOW = 5
# Bounds, in seconds, derived from the timing above and the supervisor's grace periods.
HEALTHY_BOUND = 90          # restore + initial sync + listen
HANDOVER_BOUND = 60         # request noticed within one renewal, drain, final sync, restore
TAKEOVER_BOUND = EXPIRE_SECONDS + 75  # expiry, poll, restore, initial sync
ZOMBIE_EXIT_BOUND = 60      # next renewal notices the new generation; FENCED_GRACE_MS is 15 s
COLD_START_BOUND = 90
STABLE_SECONDS = 5
STOP_TIMEOUT = "65"         # docker stop -t: the documented shutdown budget

FAKE_PROVIDER_BUCKET = "fleet-fake-provider"


class DrillError(AssertionError):
    """A drill assertion failed."""


def ensure(condition, message):
    """`message` may be a callable, so expensive context (docker logs) is only fetched on failure."""
    if not condition:
        raise DrillError(message() if callable(message) else message)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def docker(*args, timeout=90, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True,
                          capture_output=True, timeout=timeout, **kwargs).stdout.strip()


def docker_logs(name):
    """Both streams: the controller logs to stderr, Litestream to stdout."""
    result = subprocess.run(["docker", "logs", "--tail", "300", name], check=False, text=True,
                            capture_output=True, timeout=30)
    return result.stdout + result.stderr


def docker_run_args(name, image, env, network="host"):
    """The `docker run` arguments for one drill container (pure, so it is unit-tested)."""
    args = ["run", "-d", "--name", name, "--network", network]
    for key, value in env.items():
        args.extend(["-e", f"{key}={value}"])
    args.append(image)
    return args


def http_status(url, method="GET", headers=None, data=None, timeout=3):
    """The HTTP status of a request, or 0 when the connection fails."""
    try:
        request = Request(url, method=method, headers=headers or {}, data=data)
        with urlopen(request, timeout=timeout) as response:
            return response.status
    except HTTPError as error:
        return error.code
    except OSError:
        return 0


def is_ack(status):
    return 200 <= status < 300


class Acknowledged:
    """Which writes the system acknowledged, and when (monotonic seconds)."""

    def __init__(self):
        self.acked = {}
        self.refused = 0

    def record(self, email, status, at):
        if is_ack(status):
            self.acked[email] = at
        else:
            self.refused += 1

    def emails(self):
        return set(self.acked)

    def before(self, cutoff):
        """Writes acknowledged at or before the cutoff."""
        return {email for email, at in self.acked.items() if at <= cutoff}

    def merge(self, other):
        self.acked.update(other.acked)
        self.refused += other.refused


def missing(acknowledged, present):
    """Acknowledged emails absent from `present`, sorted for a readable failure."""
    return sorted(set(acknowledged) - set(present))


class Container:
    def __init__(self, name, port, prefix):
        self.name, self.port, self.prefix = name, port, prefix

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"


class Cluster:
    """Real Docker containers against disposable S3; the interface scenarios use."""

    def __init__(self, image, endpoint, token):
        self.image, self.endpoint, self.token = image, endpoint, token
        self.containers = []
        self.now = time.monotonic
        self.sleep = time.sleep

    def new_prefix(self, tag):
        return f"container-test/{tag}-{secrets.token_hex(4)}"

    def start(self, bucket, prefix, port=None, generic=False, env=None, endpoint=None):
        port = port or free_port()
        endpoint = endpoint or self.endpoint
        name = "fleet-image-test-" + secrets.token_hex(6)
        # generic: only the shared-platform S3_* names, as a hosting inventory supplies them.
        storage = ({"S3_BUCKET": bucket, "S3_ENDPOINT": endpoint, "S3_REGION": "us-east-1",
                    "S3_ACCESS_KEY_ID": "test", "S3_SECRET_ACCESS_KEY": "test"}
                   if generic else
                   {"FLEET_S3_BUCKET": bucket, "FLEET_S3_ENDPOINT": endpoint,
                    "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
                    "AWS_REGION": "us-east-1"})
        settings = {"FLEET_ADMIN_TOKEN": self.token, "FLEET_S3_PREFIX": prefix,
                    "PORT": str(port), "FLEET_STARTUP_TIMEOUT_SECONDS": "10",
                    "FLEET_OWNERSHIP_RENEW_SECONDS": str(RENEW_SECONDS),
                    "FLEET_OWNERSHIP_EXPIRE_SECONDS": str(EXPIRE_SECONDS),
                    **storage, **(env or {})}
        container = Container(name, port, prefix)
        self.containers.append(container)
        docker(*docker_run_args(name, self.image, settings))
        return container

    def wait_until(self, predicate, timeout, what, interval=0.1):
        """Polls until the predicate is truthy; returns the seconds waited."""
        began = self.now()
        while True:
            if predicate():
                return self.now() - began
            ensure(self.now() - began < timeout, f"timed out after {timeout}s waiting for {what}")
            self.sleep(interval)

    def running(self, container):
        return docker("inspect", "-f", "{{.State.Running}}", container.name) == "true"

    def exit_code(self, container):
        return int(docker("inspect", "-f", "{{.State.ExitCode}}", container.name))

    def is_healthy(self, container):
        return http_status(container.base + "/health", timeout=1) == 200

    def ready(self, container, timeout=HEALTHY_BOUND):
        def up():
            ensure(self.running(container), lambda: "container exited before readiness: " + docker_logs(container.name))
            try:
                with urlopen(container.base + "/health", timeout=1) as response:
                    return response.status == 200 and json.load(response) == {"ok": True}
            except OSError:
                return False
        self.wait_until(up, timeout, f"{container.name} readiness")

    def wait_healthy(self, container, timeout, what):
        def up():
            ensure(self.running(container), lambda: f"{what}: container exited: " + docker_logs(container.name))
            return self.is_healthy(container)
        return self.wait_until(up, timeout, what)

    def _auth(self):
        return {"Authorization": "Bearer " + self.token}

    def put_access(self, container, email):
        return http_status(f"{container.base}/v1/access/{email}", "PUT", self._auth())

    def emails(self, container):
        request = Request(container.base + "/v1/access", headers=self._auth())
        with urlopen(request, timeout=5) as response:
            ensure(response.status == 200, "GET /v1/access did not answer 200")
            return set(json.load(response)["emails"])

    def settings(self, container, method="GET", body=None):
        """The fleet settings; a write carries the current revision as If-Match (none for a new scope)."""
        url = container.base + "/v1/settings/fleet"
        headers = {**self._auth(), "Content-Type": "application/json"}
        if method == "PUT":
            with urlopen(Request(url, headers=headers), timeout=5) as current:
                revision = json.load(current).get("revision", 0)
            if revision:
                headers["If-Match"] = str(revision)
        request = Request(url, method=method, headers=headers,
                          data=None if body is None else json.dumps(body).encode())
        with urlopen(request, timeout=5) as response:
            assert response.status == 200
            return response.read().decode()

    def audit_entries(self, container):
        request = Request(container.base + "/v1/audit?limit=1", headers=self._auth())
        with urlopen(request, timeout=5) as response:
            assert response.status == 200
            assert "no-store" in response.headers.get("Cache-Control", "")
            return json.load(response)["entries"]

    def assert_schema(self, container, when):
        # Read-only, inside the container, from the database the controller itself opened.
        version = int(docker("exec", container.name, "bun", "-e", READ_SCHEMA_VERSION))
        assert version == EXPECTED_SCHEMA_VERSION, f"{when}: database schema is {version}, expected {EXPECTED_SCHEMA_VERSION}"
        assert self.audit_entries(container) is not None, f"{when}: the schema-3 audit endpoint is not answering"
        assert self.integrity(container) == "ok", f"{when}: PRAGMA integrity_check failed"

    def integrity(self, container):
        return docker("exec", container.name, "bun", "-e", READ_INTEGRITY)

    def stop(self, container):
        docker("stop", "-t", STOP_TIMEOUT, container.name, timeout=90)
        assert self.exit_code(container) == 0, f"{container.name} did not exit 0: " + docker_logs(container.name)

    def kill(self, container):
        docker("kill", container.name)

    def pause(self, container):
        docker("pause", container.name)

    def unpause(self, container):
        docker("unpause", container.name)

    def wait_exit(self, container, timeout):
        """The exit code, or None when the container is still running after `timeout`."""
        try:
            self.wait_until(lambda: not self.running(container), timeout, f"{container.name} to exit")
        except DrillError:
            return None
        return self.exit_code(container)

    def remove(self, *containers):
        docker("rm", *[container.name for container in containers])

    def logs(self, container):
        return docker_logs(container.name)

    def cleanup(self):
        for container in self.containers:
            subprocess.run(["docker", "unpause", container.name], capture_output=True, check=False)
            subprocess.run(["docker", "rm", "-f", container.name], capture_output=True, check=False)


def successor_up(cluster, successor):
    """True once the successor serves; fails fast if it died instead."""
    ensure(cluster.running(successor), lambda: f"{successor.name} exited: " + cluster.logs(successor))
    return cluster.is_healthy(successor)


def drive_writes(cluster, target, tag, until, bound, start_at=0):
    """Writes unique emails to one container until `until()` is true; returns what it acknowledged.

    Synchronous on purpose: each round writes once, then lets the caller's
    predicate look at the world (health of the successor, exit of a container).
    """
    acknowledged, sequence = Acknowledged(), start_at
    began = cluster.now()
    while not until():
        ensure(cluster.now() - began < bound, f"{tag}: writes ran longer than {bound}s without the awaited event")
        email = f"{tag}-{sequence:05d}@example.test"
        acknowledged.record(email, cluster.put_access(target, email), cluster.now())
        sequence += 1
        cluster.sleep(0.05)
    return acknowledged


def write_batch(cluster, target, tag, count, start_at=0):
    """`count` writes that must all be acknowledged."""
    acknowledged = Acknowledged()
    for sequence in range(start_at, start_at + count):
        email = f"{tag}-{sequence:05d}@example.test"
        status = cluster.put_access(target, email)
        ensure(is_ack(status), f"write {email} to {target.name} answered {status}")
        acknowledged.record(email, status, cluster.now())
    return acknowledged


def verify_restorable(cluster, bucket, prefix, expected, when, exact=True):
    """The corruption guard: a fresh container restores the prefix, intact and as expected."""
    fresh = cluster.start(bucket, prefix)
    cluster.ready(fresh)
    cluster.assert_schema(fresh, when)
    result = cluster.integrity(fresh)
    ensure(result == "ok", f"{when}: PRAGMA integrity_check answered {result!r}")
    restored = cluster.emails(fresh)
    ensure(not missing(expected, restored), f"{when}: restore lost acknowledged writes {missing(expected, restored)}")
    if exact:
        ensure(restored == set(expected), f"{when}: restore holds unexpected state {sorted(restored - set(expected))}")
    cluster.stop(fresh)
    cluster.remove(fresh)


def observe_single_server(cluster, containers, bound, stable):
    """Waits until exactly one container serves, stably; two serving at once is a failure."""
    last = None
    began = since = cluster.now()
    while cluster.now() - began < bound:
        for container in containers:
            ensure(cluster.running(container), lambda: f"{container.name} exited: " + cluster.logs(container))
        up = tuple(cluster.is_healthy(container) for container in containers)
        ensure(sum(up) <= 1, "two containers served at the same time")
        if up != last or not any(up):
            last, since = up, cluster.now()
        elif cluster.now() - since >= stable:
            return containers[up.index(True)]
        cluster.sleep(0.2)
    raise DrillError(f"no single stable server within {bound}s")


# ---------------------------------------------------------------- scenarios

def scenario_basics(cluster, bucket, denied_bucket):
    # Entrypoint validates real configuration; no synthetic fallback.
    invalid = subprocess.run(["docker", "run", "--rm", cluster.image], capture_output=True,
                             text=True, timeout=20)
    assert invalid.returncode != 0
    assert "FLEET_ADMIN_TOKEN" in invalid.stdout + invalid.stderr
    prefix = cluster.new_prefix("basics")
    c = cluster.start(bucket, prefix)
    cluster.ready(c)
    cluster.assert_schema(c, "fresh database")
    cluster.settings(c, "PUT", {"heartbeat": {"intervalSeconds": 91}})
    cluster.stop(c)
    docker("start", c.name)
    cluster.ready(c)
    cluster.assert_schema(c, "after restart")
    assert "91" in cluster.settings(c), "ordinary restart lost settings"
    cluster.stop(c)
    cluster.remove(c)
    # Entire local filesystem is gone; same prefix restores the durable replica,
    # configured through the generic S3_* names Litestream must still receive.
    c = cluster.start(bucket, prefix, generic=True)
    cluster.ready(c)
    cluster.assert_schema(c, "restored replica")
    assert "91" in cluster.settings(c), "replacement failed to restore settings"
    cluster.stop(c)
    cluster.remove(c)

    # Rolling deploy as the platform does it: the new container starts while the
    # old one still serves writes. The old one hands over and stays as a standby.
    old = cluster.start(bucket, prefix)
    cluster.ready(old)
    new = cluster.start(bucket, prefix)
    acknowledged = drive_writes(cluster, old, "basics-handover", lambda: successor_up(cluster, new),
                                HANDOVER_BOUND)
    assert acknowledged.refused > 0, "old writer never paused writes during hand-over"
    assert not missing(acknowledged.emails(), cluster.emails(new)), "acknowledged write lost in hand-over"
    assert "91" in cluster.settings(new), "hand-over lost settings"
    assert cluster.running(old), "old container must stay as standby"
    state = cluster.emails(new)
    cluster.stop(old)
    cluster.stop(new)
    cluster.remove(old, new)
    verify_restorable(cluster, bucket, prefix, state, "basics: fresh restore after hand-over")

    # A write-denied bucket must fail startup closed with the conditional-write message.
    denied = cluster.start(denied_bucket, cluster.new_prefix("denied"))
    assert docker("wait", denied.name) != "0", "denied writes must fail startup"
    assert not cluster.is_healthy(denied), "write-denied container accepted traffic"
    assert "conditional write" in cluster.logs(denied), "denied writes gave no clear message"
    cluster.remove(denied)


def scenario_rolling_deploy(cluster, bucket):
    prefix = cluster.new_prefix("rolling")
    a = cluster.start(bucket, prefix)
    cluster.ready(a)
    acknowledged = write_batch(cluster, a, "rolling-pre", 5)
    b = cluster.start(bucket, prefix)
    during = drive_writes(cluster, a, "rolling-a", lambda: successor_up(cluster, b), HANDOVER_BOUND)
    acknowledged.merge(during)
    ensure(during.refused > 0, "A kept acknowledging writes for the whole hand-over")
    ensure(cluster.running(a), "A must stay alive as a standby after handing over")
    on_b = cluster.emails(b)
    ensure(not missing(acknowledged.emails(), on_b), f"writes A acknowledged are missing on B: {missing(acknowledged.emails(), on_b)}")
    acknowledged.merge(write_batch(cluster, b, "rolling-b", 3))
    ensure(cluster.put_access(a, "rolling-standby@example.test") != 200, "the standby acknowledged a write")
    cluster.stop(a)  # SIGTERM, generous budget: a standby exits 0
    state = cluster.emails(b)
    ensure(not missing(acknowledged.emails(), state), "B lost an acknowledged write after A stopped")
    cluster.stop(b)
    verify_restorable(cluster, bucket, prefix, state, "rolling-deploy: fresh restore")
    print(f"   rolling-deploy: {len(acknowledged.acked)} acknowledged writes, {during.refused} refused during hand-over")


def scenario_zero_drain_kill(cluster, bucket):
    prefix = cluster.new_prefix("zerodrain")
    a = cluster.start(bucket, prefix)
    cluster.ready(a)
    acknowledged = write_batch(cluster, a, "zerodrain-pre", 5)
    b = cluster.start(bucket, prefix)
    during = drive_writes(cluster, a, "zerodrain-a", lambda: successor_up(cluster, b), HANDOVER_BOUND)
    acknowledged.merge(during)
    cluster.kill(a)  # SIGKILL the instant B is serving: the platform's default 0 s drain
    on_b = cluster.emails(b)
    ensure(not missing(acknowledged.emails(), on_b),
           f"zero-drain kill lost acknowledged writes: {missing(acknowledged.emails(), on_b)}")
    acknowledged.merge(write_batch(cluster, b, "zerodrain-b", 3))
    state = cluster.emails(b)
    cluster.stop(b)
    verify_restorable(cluster, bucket, prefix, state, "zero-drain-kill: fresh restore")
    print(f"   zero-drain-kill: {len(acknowledged.acked)} acknowledged writes, none lost")


def scenario_crash_takeover(cluster, bucket):
    prefix = cluster.new_prefix("crash")
    a = cluster.start(bucket, prefix)
    cluster.ready(a)
    begin = cluster.now()
    acknowledged = drive_writes(cluster, a, "crash-a", lambda: cluster.now() - begin >= 8, 30)
    ensure(len(acknowledged.acked) > 0, "A acknowledged nothing before the crash")
    killed_at = cluster.now()
    cluster.kill(a)  # no hand-over, no release
    b = cluster.start(bucket, prefix)  # starts after the kill: must wait out the expiry
    waited = cluster.wait_healthy(b, TAKEOVER_BOUND, "B to take over after the lease expired")
    ensure(waited >= EXPIRE_SECONDS - 1, f"B took over after {waited:.0f}s, before the {EXPIRE_SECONDS}s expiry")
    ensure("taking over from a writer that stopped renewing" in cluster.logs(b), "B did not log a takeover")
    survivors = acknowledged.before(killed_at - CRASH_LOSS_WINDOW)
    on_b = cluster.emails(b)
    ensure(not missing(survivors, on_b),
           f"writes acknowledged {CRASH_LOSS_WINDOW}s before the crash were lost: {missing(survivors, on_b)}")
    lost = len(missing(acknowledged.emails(), on_b))
    batch = write_batch(cluster, b, "crash-b", 3)
    state = cluster.emails(b)
    ensure(not missing(batch.emails(), state), "B lost its own write")
    cluster.stop(b)
    verify_restorable(cluster, bucket, prefix, state, "crash-takeover: fresh restore")
    print(f"   crash-takeover: B served {waited:.0f}s after start; {lost} of {len(acknowledged.acked)} writes inside the loss window were not replicated")


def scenario_zombie(cluster, bucket):
    prefix = cluster.new_prefix("zombie")
    a = cluster.start(bucket, prefix)
    cluster.ready(a)
    before = write_batch(cluster, a, "zombie-a", 5)
    cluster.sleep(CRASH_LOSS_WINDOW)  # let them replicate
    cluster.pause(a)  # frozen: no renewals, no writes, like a hung host
    b = cluster.start(bucket, prefix)
    waited = cluster.wait_healthy(b, TAKEOVER_BOUND, "B to take over from the paused A")
    ensure(waited >= EXPIRE_SECONDS - 1, f"B took over after {waited:.0f}s, before the {EXPIRE_SECONDS}s expiry")
    acknowledged = write_batch(cluster, b, "zombie-b", 3)
    cluster.unpause(a)
    # From the moment A resumes until it exits, nothing it receives may be acknowledged.
    attempts = []

    def resumed_and_gone():
        email = f"zombie-late-{len(attempts):05d}@example.test"
        status = cluster.put_access(a, email)
        attempts.append((email, status))
        ensure(not is_ack(status), f"the resumed zombie acknowledged {email} ({status})")
        return not cluster.running(a)

    cluster.wait_until(resumed_and_gone, ZOMBIE_EXIT_BOUND, "the zombie to exit", interval=0.2)
    code = cluster.exit_code(a)
    ensure(code != 0, lambda: f"the fenced zombie exited {code}; it must exit nonzero: " + cluster.logs(a))
    state = cluster.emails(b)
    ensure(not missing(before.emails(), state), f"writes A acknowledged before the pause are missing: {missing(before.emails(), state)}")
    ensure(not missing(acknowledged.emails(), state), "B lost an acknowledged write after the zombie resumed")
    ensure(not any(email in state for email, _ in attempts), "a write sent to the zombie reached the replica")
    cluster.stop(b)
    verify_restorable(cluster, bucket, prefix, state, "zombie: fresh restore")
    print(f"   zombie: {len(attempts)} writes sent to the resumed zombie, none acknowledged; it exited {code}")


def scenario_cold_start(cluster, bucket):
    prefix = cluster.new_prefix("cold")
    first, second = cluster.start(bucket, prefix), cluster.start(bucket, prefix)
    serving = observe_single_server(cluster, [first, second], COLD_START_BOUND, STABLE_SECONDS)
    other = second if serving is first else first
    acknowledged = write_batch(cluster, serving, "cold", 3)
    ensure(cluster.put_access(other, "cold-other@example.test") != 200, "the second instance acknowledged a write")
    ensure(not cluster.is_healthy(other), "the second instance reported healthy")
    state = cluster.emails(serving)
    ensure(not missing(acknowledged.emails(), state), "the serving instance lost an acknowledged write")
    ensure("cold-other@example.test" not in state, "the standby's write reached the replica")
    cluster.stop(first)
    cluster.stop(second)
    verify_restorable(cluster, bucket, prefix, state, "cold-start: fresh restore")


class FakeS3:
    """A loopback S3 that ignores If-None-Match / If-Match: a provider without conditional writes."""

    def __init__(self):
        self.objects, self.requests = {}, []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _key(self):
                parts = urlparse(self.path)
                return unquote(parts.path).lstrip("/").split("/", 1)[1:] or [""], parse_qs(parts.query)

            def _reply(self, status, body=b"", headers=None):
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _handle(self):
                (key,), query = self._key()
                outer.requests.append((self.command, key))
                if self.command == "PUT":
                    body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                    outer.objects[key] = body
                    return self._reply(200, headers={"ETag": f'"{hashlib.md5(body).hexdigest()}"'})
                if self.command == "DELETE":
                    outer.objects.pop(key, None)
                    return self._reply(204)
                if key == "":
                    prefix = query.get("prefix", [""])[0]
                    listed = "".join(f"<Contents><Key>{name}</Key></Contents>" for name in outer.objects if name.startswith(prefix))
                    return self._reply(200, f"<ListBucketResult><IsTruncated>false</IsTruncated>{listed}</ListBucketResult>".encode(),
                                       {"Content-Type": "application/xml"})
                if key not in outer.objects:
                    return self._reply(404, b"<Error><Code>NoSuchKey</Code></Error>")
                body = outer.objects[key]
                return self._reply(200, body, {"ETag": f'"{hashlib.md5(body).hexdigest()}"'})

            do_GET = do_PUT = do_HEAD = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def scenario_unsupported_provider(cluster, fake_factory=FakeS3):
    fake = fake_factory()
    try:
        container = cluster.start(FAKE_PROVIDER_BUCKET, cluster.new_prefix("provider"), endpoint=fake.endpoint)
        exited = cluster.wait_exit(container, HEALTHY_BOUND)
        ensure(exited is not None, lambda: "a provider ignoring conditional writes did not stop startup: " + cluster.logs(container))
        ensure(exited != 0, f"startup exited {exited} against a provider without conditional writes")
        logs = cluster.logs(container)
        for text in ("If-None-Match", "If-Match", "conditional write"):
            ensure(text in logs, f"startup refusal does not mention {text!r}: {logs}")
        ensure("fleet controller listening" not in logs, "the controller listened against an unsupported provider")
        ensure("claimed writer ownership" not in logs, "ownership was claimed against an unsupported provider")
        ensure(not cluster.is_healthy(container), "an unsupported provider's container accepted traffic")
        touched = {key for _, key in fake.requests if key and "/probes/" not in key}
        ensure(not touched, f"startup wrote beyond the probe object: {sorted(touched)}")
        cluster.remove(container)
    finally:
        fake.stop()


SCENARIOS = [
    ("basics", scenario_basics, ("bucket", "denied")),
    ("rolling-deploy", scenario_rolling_deploy, ("bucket",)),
    ("zero-drain-kill", scenario_zero_drain_kill, ("bucket",)),
    ("crash-takeover", scenario_crash_takeover, ("bucket",)),
    ("zombie", scenario_zombie, ("bucket",)),
    ("cold-start", scenario_cold_start, ("bucket",)),
    ("unsupported", scenario_unsupported_provider, ()),
]


def run_scenario(cluster, name, function, arguments, announce=print):
    """Runs one named scenario; on failure prints the logs of every container it started."""
    announce(f"== scenario: {name}")
    mark, began = len(cluster.containers), cluster.now()
    try:
        function(cluster, *arguments)
    except BaseException:
        for container in cluster.containers[mark:]:
            try:
                announce(f"-- docker logs {container.name} (prefix {container.prefix}) --\n{cluster.logs(container)}")
            except Exception as error:  # a container that never started has no logs
                announce(f"-- no logs for {container.name}: {error}")
        raise
    announce(f"   ok: {name} ({cluster.now() - began:.0f}s)")


def selected(names):
    known = {name for name, _, _ in SCENARIOS}
    unknown = set(names) - known
    ensure(not unknown, f"unknown scenarios {sorted(unknown)}; choose from {sorted(known)}")
    return [entry for entry in SCENARIOS if not names or entry[0] in names]


def main():
    image, names = sys.argv[1], sys.argv[2:]
    plan = selected(names)
    import boto3  # imported late: the offline self-test needs neither boto3 nor moto

    s3_port = free_port()
    endpoint = f"http://127.0.0.1:{s3_port}"
    token = secrets.token_hex(32)
    cluster = Cluster(image, endpoint, token)
    service = subprocess.Popen(
        [sys.executable, "-m", "moto.server", "-H", "127.0.0.1", "-p", str(s3_port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                with urlopen(endpoint, timeout=1):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("disposable S3 server did not start")
        s3 = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id="test",
                          aws_secret_access_key="test", region_name="us-east-1")
        for bucket in ("fleet-container-test", "fleet-container-denied"):
            s3.create_bucket(Bucket=bucket)
        s3.put_bucket_policy(Bucket="fleet-container-denied", Policy=json.dumps({
            "Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Principal": "*",
                "Action": "s3:PutObject", "Resource": "arn:aws:s3:::fleet-container-denied/*"}]
        }))
        available = {"bucket": "fleet-container-test", "denied": "fleet-container-denied"}
        for name, function, needs in plan:
            run_scenario(cluster, name, function, [available[need] for need in needs])
        print("PASS: " + ", ".join(name for name, _, _ in plan)
              + " (configuration refusal, readiness, schema, graceful stop, restart, fresh restore via S3_* names,"
              " rolling hand-over, zero-drain kill, crash takeover, zombie fencing, simultaneous cold start,"
              " unsupported providers, integrity after every scenario)")
    finally:
        cluster.cleanup()
        service.terminate()
        service.wait(timeout=10)


if __name__ == "__main__":
    main()
