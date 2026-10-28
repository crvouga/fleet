"""Linux Docker acceptance with disposable Moto storage; no production credentials."""
import json
import secrets
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen

# The schema version this image must create or upgrade to (packages/fleet-controller/src/db/migrations.ts).
EXPECTED_SCHEMA_VERSION = 3
READ_SCHEMA_VERSION = ("const {Database}=require('bun:sqlite');"
                       "const db=new Database(process.env.FLEET_DATABASE_PATH,{readonly:true});"
                       "process.stdout.write(String(db.query('PRAGMA user_version').get().user_version))")

import boto3


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True,
                          capture_output=True, timeout=90, **kwargs).stdout.strip()


def main():
    image = sys.argv[1]
    s3_port, port = free_port(), free_port()
    endpoint = f"http://127.0.0.1:{s3_port}"
    base = f"http://127.0.0.1:{port}"
    token = secrets.token_hex(32)
    names = []
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

        def start(bucket):
            name = "fleet-image-test-" + secrets.token_hex(6)
            names.append(name)
            env = {"FLEET_ADMIN_TOKEN": token, "FLEET_S3_BUCKET": bucket,
                   "FLEET_S3_ENDPOINT": endpoint, "FLEET_S3_PREFIX": "container-test",
                   "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
                   "AWS_REGION": "us-east-1", "PORT": str(port),
                   "FLEET_STARTUP_TIMEOUT_SECONDS": "10"}
            args = ["run", "-d", "--name", name, "--network", "host"]
            for key, value in env.items():
                args.extend(["-e", f"{key}={value}"])
            docker(*args, image)
            return name

        def ready(name):
            for _ in range(300):
                if docker("inspect", "-f", "{{.State.Running}}", name) != "true":
                    raise RuntimeError("container exited before readiness: " + docker("logs", name))
                try:
                    with urlopen(base + "/health", timeout=1) as response:
                        if response.status == 200 and json.load(response) == {"ok": True}:
                            return
                except OSError:
                    pass
                time.sleep(0.1)
            raise RuntimeError("container readiness timed out")

        def settings(method="GET", body=None):
            request = Request(base + "/v1/settings/fleet", method=method,
                              headers={"Authorization": "Bearer " + token,
                                       "Content-Type": "application/json"},
                              data=None if body is None else json.dumps(body).encode())
            with urlopen(request, timeout=5) as response:
                assert response.status == 200
                return response.read().decode()

        def audit_entries():
            request = Request(base + "/v1/audit?limit=1", headers={"Authorization": "Bearer " + token})
            with urlopen(request, timeout=5) as response:
                assert response.status == 200
                assert "no-store" in response.headers.get("Cache-Control", "")
                return json.load(response)["entries"]

        def assert_schema(name, when):
            # Read-only, inside the container, from the database the controller itself opened.
            version = int(docker("exec", name, "bun", "-e", READ_SCHEMA_VERSION))
            assert version == EXPECTED_SCHEMA_VERSION, f"{when}: database schema is {version}, expected {EXPECTED_SCHEMA_VERSION}"
            assert audit_entries() is not None, f"{when}: the schema-3 audit endpoint is not answering"

        def stop(name):
            docker("stop", "-t", "65", name)
            assert docker("inspect", "-f", "{{.State.ExitCode}}", name) == "0"

        # Entrypoint validates real configuration; no synthetic fallback.
        invalid = subprocess.run(["docker", "run", "--rm", image], capture_output=True,
                                 text=True, timeout=20)
        assert invalid.returncode != 0
        assert "FLEET_ADMIN_TOKEN" in invalid.stdout + invalid.stderr
        name = start("fleet-container-test")
        ready(name)
        assert_schema(name, "fresh database")
        settings("PUT", {"heartbeat": {"intervalSeconds": 91}})
        stop(name)
        docker("start", name)
        ready(name)
        assert_schema(name, "after restart")
        assert "91" in settings(), "ordinary restart lost settings"
        stop(name)
        docker("rm", name)
        # Entire local filesystem is gone; same prefix restores the durable replica.
        name = start("fleet-container-test")
        ready(name)
        assert_schema(name, "restored replica")
        assert "91" in settings(), "replacement failed to restore settings"
        stop(name)
        denied = start("fleet-container-denied")
        assert docker("wait", denied) != "0", "denied writes must fail startup"
        try:
            with urlopen(base + "/health", timeout=1):
                raise AssertionError("write-denied container accepted traffic")
        except OSError:
            pass
        print("PASS: configuration refusal, readiness, schema version, graceful stop, restart, fresh restore, denied writes")
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        service.terminate()
        service.wait(timeout=10)


if __name__ == "__main__":
    main()
