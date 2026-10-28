"""Offline self-test for scripts/check-container.py: no Docker, no S3, no network beyond loopback.

It exercises the drill code that does not need containers (acknowledged-write
bookkeeping, bounded waits, command construction, the fake S3, failure logs)
and runs every scenario once against a simulated cluster with a virtual
clock, so a typo or a wrong assertion in the orchestration shows up here.
It also injects the faults the drills exist to catch (lost write at hand-over,
zombie that acknowledges, early takeover, two servers) and requires the
scenarios to fail. The simulation is NOT the system: the real drills still
need Docker (`python scripts/check-container.py <image>`).

Run: python3 -I scripts/check-container-selftest.py
"""
import importlib.util
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from subprocess import CompletedProcess
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("check_container", os.path.join(HERE, "check-container.py"))
drills = importlib.util.module_from_spec(spec)
sys.modules["check_container"] = drills
spec.loader.exec_module(drills)

DENIED = "fleet-container-denied"
BUCKET = "fleet-container-test"


class World:
    def __init__(self):
        self.replica, self.owner, self.lease_seen, self.settings = set(), None, 0.0, None


class Sim(drills.Cluster):
    """A deliberately simple model of the single-writer protocol on a virtual clock."""

    def __init__(self, drop_on_handover=False, zombie_acks=False, early_takeover=False,
                 never_fences=False, two_owners=False):
        super().__init__("image:test", "http://127.0.0.1:1", "t" * 64)
        self.t, self.worlds, self.ports = 0.0, {}, 40000
        self.drop, self.zombie_acks, self.early = drop_on_handover, zombie_acks, early_takeover
        self.never_fences, self.two_owners = never_fences, two_owners
        self.now, self.sleep = lambda: self.t, self._sleep

    def _sleep(self, seconds):
        for _ in range(max(1, round(seconds / 0.05))):
            self._step(0.05)

    def _world(self, container):
        return self.worlds.setdefault(container.prefix, World())

    def _claim(self, container, world, replica_only=False):
        world.owner, container.state = container, "claimed"
        container.ready_at, container.data = self.t + 3, set(world.replica)
        container.pending = {}

    def _step(self, dt):
        self.t += dt
        for container in self.containers:
            self._step_container(container)

    def _alive(self, container):
        return container.state != "exited" and not container.paused

    def _step_container(self, c):
        w = self._world(c)
        if c.state == "claimed" and self.t >= c.ready_at and self._alive(c):
            c.state = "serving"
        if c.state in ("claimed", "serving", "draining") and self._alive(c):
            if w.owner is c:
                w.lease_seen = self.t
            elif not self.two_owners:
                c.state, c.fence_exit_at = "fenced", self.t + 3
            for email, at in list(c.pending.items()):
                if self.t - at >= 1.0 and not self.drop:
                    w.replica.add(email)
                    del c.pending[email]
        if c.state == "draining" and self.t >= c.drain_done:
            if not self.drop:
                w.replica |= c.data
            c.state = "standby"
            if c.successor is not None:
                self._claim(c.successor, w)
        if c.state == "fenced" and self.t >= c.fence_exit_at and not self.never_fences:
            c.state, c.code = "exited", 1
        if c.state == "starting" and self._alive(c):
            self._acquire(c, w)

    def _acquire(self, c, w):
        owner = w.owner
        if self.two_owners and owner is not None:
            return self._claim(c, w)
        if owner is None or owner.state in ("standby", "fenced") or (owner.state == "exited" and owner.code == 0):
            return self._claim(c, w)
        if owner.state in ("claimed", "serving") and self._alive(owner):
            owner.state, owner.drain_done, owner.successor = "draining", self.t + 4, c
            c.state = "waiting"
            return None
        if not self._alive(owner) and self.t - w.lease_seen >= (5 if self.early else drills.EXPIRE_SECONDS):
            c.log.append("taking over from a writer that stopped renewing")
            owner.successor = None
            return self._claim(c, w)
        return None

    # -- the Cluster interface -------------------------------------------------
    def start(self, bucket, prefix, port=None, generic=False, env=None, endpoint=None):
        self.ports += 1
        c = drills.Container(f"sim-{len(self.containers)}", port or self.ports, prefix)
        c.state, c.paused, c.code, c.log = "starting", False, None, []
        c.data, c.pending, c.successor, c.drain_done = set(), {}, None, 0
        self.containers.append(c)
        if endpoint is not None or bucket == DENIED:
            c.state, c.code = "exited", 1
            c.log.append("startup failed: Object storage refused or ignored a conditional write "
                         "(If-None-Match / If-Match). The Fleet controller did not start listening.")
        return c

    def running(self, c):
        return c.state != "exited"

    def exit_code(self, c):
        return c.code

    def is_healthy(self, c):
        return c.state == "serving" and not c.paused

    def ready(self, c, timeout=drills.HEALTHY_BOUND):
        self.wait_healthy(c, timeout, "ready")

    def put_access(self, c, email):
        if c.paused or c.state in ("exited", "starting", "claimed", "standby", "waiting"):
            return 0
        if c.state == "serving" or (c.state == "fenced" and self.zombie_acks):
            c.data.add(email)
            c.pending[email] = self.t
            return 200
        return 503

    def emails(self, c):
        if c.state not in ("serving", "draining", "fenced") or c.paused:
            raise OSError("not listening")
        return set(c.data)

    def settings(self, c, method="GET", body=None):
        w = self._world(c)
        if method == "PUT":
            w.settings = json.dumps(body)
        return w.settings or "{}"

    def audit_entries(self, c):
        return []

    def assert_schema(self, c, when):
        return None

    def integrity(self, c):
        return "ok"

    def stop(self, c):
        w = self._world(c)
        if c.state in ("serving", "draining") and w.owner is c:
            w.replica |= c.data
            w.owner = None
        c.state, c.code = "exited", 0

    def kill(self, c):
        c.state, c.code = "exited", 137

    def pause(self, c):
        c.paused = True

    def unpause(self, c):
        c.paused = False
        # The write gate is wall-clock based: a resumed owner whose lease passed refuses at once.
        if self._world(c).owner is not c and c.state in ("claimed", "serving", "draining"):
            c.state, c.fence_exit_at = "fenced", self.t + 3

    def remove(self, *containers):
        return None

    def logs(self, c):
        return "\n".join(c.log)

    def cleanup(self):
        return None

    def docker(self, *args, **kwargs):
        by_name = {c.name: c for c in self.containers}
        if args[0] == "start":
            c = by_name[args[1]]
            c.state, c.code = "starting", None
            return ""
        if args[0] == "wait":
            c = by_name[args[1]]
            self.wait_until(lambda: c.state == "exited", 60, "wait")
            return str(c.code)
        raise AssertionError(f"unexpected docker call {args}")


def run(scenario, sim, *arguments):
    with redirect_stdout(io.StringIO()) as out:
        scenario(sim, *arguments)
    return out.getvalue()


class Bookkeeping(unittest.TestCase):
    def test_acknowledged_set_inclusion(self):
        ack = drills.Acknowledged()
        ack.record("a@example.test", 200, 1.0)
        ack.record("b@example.test", 503, 2.0)
        ack.record("c@example.test", 0, 3.0)
        ack.record("d@example.test", 204, 9.0)
        self.assertEqual(ack.emails(), {"a@example.test", "d@example.test"})
        self.assertEqual(ack.refused, 2)
        self.assertEqual(ack.before(5.0), {"a@example.test"})
        self.assertEqual(drills.missing(ack.emails(), {"a@example.test"}), ["d@example.test"])
        other = drills.Acknowledged()
        other.record("e@example.test", 200, 10.0)
        ack.merge(other)
        self.assertIn("e@example.test", ack.emails())

    def test_ensure_is_lazy_about_context(self):
        calls = []
        drills.ensure(True, lambda: calls.append("expensive"))
        self.assertEqual(calls, [])
        with self.assertRaises(drills.DrillError) as caught:
            drills.ensure(False, lambda: "docker logs here")
        self.assertIn("docker logs here", str(caught.exception))

    def test_bounded_wait(self):
        sim = Sim()
        self.assertGreaterEqual(sim.wait_until(lambda: sim.t >= 1.0, 5, "one second"), 1.0)
        with self.assertRaises(drills.DrillError) as caught:
            sim.wait_until(lambda: False, 2, "never")
        self.assertIn("timed out after 2s waiting for never", str(caught.exception))
        self.assertLess(sim.t, 3.5)

    def test_writes_are_bounded_and_unique(self):
        sim = Sim()
        c = sim.start(BUCKET, "p")
        sim.ready(c)
        end = sim.t + 2
        ack = drills.drive_writes(sim, c, "t", lambda: sim.t > end, 10)
        self.assertEqual(len(ack.emails()), len(ack.acked))
        self.assertGreater(len(ack.acked), 10)
        with self.assertRaises(drills.DrillError):
            drills.drive_writes(sim, c, "t", lambda: False, 1)
        sim.kill(c)
        with self.assertRaises(drills.DrillError):
            drills.write_batch(sim, c, "t", 1)

    def test_command_construction(self):
        args = drills.docker_run_args("n", "img", {"A": "1", "B": "2"})
        self.assertEqual(args, ["run", "-d", "--name", "n", "--network", "host", "-e", "A=1", "-e", "B=2", "img"])
        calls = []
        with mock.patch.object(drills, "docker", lambda *a, **k: calls.append(a) or ""):
            cluster = drills.Cluster("img:1", "http://127.0.0.1:9", "tok")
            first = cluster.start("bkt", "container-test/x", port=18080)
            generic = cluster.start("bkt", "container-test/y", port=18081, generic=True,
                                    env={"FLEET_OWNERSHIP_EXPIRE_SECONDS": "30"})
        run_args = calls[0]
        self.assertEqual(run_args[:2], ("run", "-d"))
        self.assertEqual(run_args[-1], "img:1")
        self.assertIn("FLEET_S3_BUCKET=bkt", run_args)
        self.assertIn("FLEET_OWNERSHIP_EXPIRE_SECONDS=15", run_args)
        self.assertIn("FLEET_OWNERSHIP_RENEW_SECONDS=1", run_args)
        self.assertIn("PORT=18080", run_args)
        self.assertIn("FLEET_S3_PREFIX=container-test/x", run_args)
        self.assertTrue(first.name.startswith("fleet-image-test-"))
        self.assertIn("S3_BUCKET=bkt", calls[1])
        self.assertNotIn("FLEET_S3_BUCKET=bkt", calls[1])
        self.assertIn("FLEET_OWNERSHIP_EXPIRE_SECONDS=30", calls[1])
        self.assertNotIn("FLEET_OWNERSHIP_EXPIRE_SECONDS=15", calls[1])
        self.assertEqual([c.name for c in cluster.containers], [first.name, generic.name])

    def test_prefixes_are_unique_per_scenario(self):
        sim = Sim()
        self.assertNotEqual(sim.new_prefix("a"), sim.new_prefix("a"))
        self.assertTrue(sim.new_prefix("rolling").startswith("container-test/rolling-"))

    def test_scenario_selection(self):
        self.assertEqual([n for n, _, _ in drills.selected([])], [n for n, _, _ in drills.SCENARIOS])
        self.assertEqual([n for n, _, _ in drills.selected(["zombie"])], ["zombie"])
        with self.assertRaises(drills.DrillError):
            drills.selected(["nonsense"])

    def test_failure_prints_logs_of_that_scenario_only(self):
        sim = Sim()
        earlier = sim.start(BUCKET, "p0")
        earlier.log.append("EARLIER-CONTAINER-LOG")

        def failing(cluster):
            started = cluster.start(BUCKET, "p1")
            started.log.append("THIS-SCENARIO-LOG")
            raise drills.DrillError("boom")

        lines = []
        with self.assertRaises(drills.DrillError):
            drills.run_scenario(sim, "failing", failing, [], announce=lines.append)
        text = "\n".join(lines)
        self.assertIn("== scenario: failing", text)
        self.assertIn("THIS-SCENARIO-LOG", text)
        self.assertNotIn("EARLIER-CONTAINER-LOG", text)

    def test_http_status_reports_connection_failure_as_zero(self):
        self.assertEqual(drills.http_status("http://127.0.0.1:1/health", timeout=1), 0)


class FakeProvider(unittest.TestCase):
    def test_fake_s3_ignores_conditions_like_an_unsupported_provider(self):
        fake = drills.FakeS3()
        try:
            def put(key, headers):
                request = Request(f"{fake.endpoint}/bkt/{key}", method="PUT", data=b"{}", headers=headers)
                with urlopen(request, timeout=3) as response:
                    return response.status, response.headers["ETag"]

            self.assertEqual(put("p/probe.json", {"If-None-Match": "*"})[0], 200)
            self.assertEqual(put("p/probe.json", {"If-None-Match": "*"})[0], 200)  # not 412
            self.assertEqual(put("p/probe.json", {"If-Match": '"stale"'})[0], 200)  # not 412
            with urlopen(f"{fake.endpoint}/bkt/p/probe.json", timeout=3) as response:
                self.assertEqual(response.read(), b"{}")
            with urlopen(f"{fake.endpoint}/bkt?list-type=2&prefix=p/", timeout=3) as response:
                self.assertIn(b"<Key>p/probe.json</Key>", response.read())
            request = Request(f"{fake.endpoint}/bkt/p/probe.json", method="DELETE")
            with urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 204)
            with self.assertRaises(HTTPError) as caught:
                urlopen(f"{fake.endpoint}/bkt/p/probe.json", timeout=3)
            self.assertEqual(caught.exception.code, 404)
            self.assertEqual(fake.requests[0], ("PUT", "p/probe.json"))
        finally:
            fake.stop()


class Scenarios(unittest.TestCase):
    """Every scenario runs once against the simulation; injected faults must fail it."""

    def test_basics(self):
        sim = Sim()
        invalid = CompletedProcess([], 1, stdout="", stderr="FLEET_ADMIN_TOKEN is required")
        with mock.patch.object(drills.subprocess, "run", return_value=invalid), \
                mock.patch.object(drills, "docker", sim.docker):
            run(drills.scenario_basics, sim, BUCKET, DENIED)

    def test_rolling_deploy(self):
        out = run(drills.scenario_rolling_deploy, Sim(), BUCKET)
        self.assertIn("acknowledged writes", out)

    def test_zero_drain_kill(self):
        run(drills.scenario_zero_drain_kill, Sim(), BUCKET)

    def test_crash_takeover(self):
        out = run(drills.scenario_crash_takeover, Sim(), BUCKET)
        self.assertIn("B served", out)

    def test_zombie(self):
        run(drills.scenario_zombie, Sim(), BUCKET)

    def test_cold_start(self):
        run(drills.scenario_cold_start, Sim(), BUCKET)

    def test_unsupported_provider(self):
        run(drills.scenario_unsupported_provider, Sim())

    def test_unsupported_provider_that_starts_is_a_failure(self):
        sim = Sim()
        sim.start = lambda bucket, prefix, **kw: Sim.start(sim, BUCKET, prefix)  # ignores the fake endpoint
        with self.assertRaises(drills.DrillError):
            run(drills.scenario_unsupported_provider, sim)

    def test_the_registry_runs_through_run_scenario(self):
        sim = Sim()
        lines = []
        drills.run_scenario(sim, "cold-start", drills.scenario_cold_start, [BUCKET], announce=lines.append)
        self.assertEqual(lines[0], "== scenario: cold-start")
        self.assertTrue(lines[-1].startswith("   ok: cold-start"))

    def test_lost_write_at_handover_fails_rolling_deploy_and_zero_drain(self):
        for scenario in (drills.scenario_rolling_deploy, drills.scenario_zero_drain_kill):
            with self.assertRaises(drills.DrillError) as caught:
                run(scenario, Sim(drop_on_handover=True), BUCKET)
            self.assertRegex(str(caught.exception), r"missing|lost acknowledged")

    def test_zombie_that_acknowledges_fails(self):
        with self.assertRaises(drills.DrillError) as caught:
            run(drills.scenario_zombie, Sim(zombie_acks=True), BUCKET)
        self.assertIn("acknowledged", str(caught.exception))

    def test_zombie_that_never_exits_fails(self):
        with self.assertRaises(drills.DrillError) as caught:
            run(drills.scenario_zombie, Sim(never_fences=True), BUCKET)
        self.assertIn("zombie to exit", str(caught.exception))

    def test_takeover_before_expiry_fails(self):
        with self.assertRaises(drills.DrillError) as caught:
            run(drills.scenario_crash_takeover, Sim(early_takeover=True), BUCKET)
        self.assertIn("before the", str(caught.exception))

    def test_two_servers_on_one_prefix_fail_cold_start(self):
        with self.assertRaises(drills.DrillError) as caught:
            run(drills.scenario_cold_start, Sim(two_owners=True), BUCKET)
        self.assertIn("two containers served", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=1)
