"""Linux Docker acceptance with disposable Moto storage; no production credentials."""
import json
import secrets
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen

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

        def start(bucket, generic=False, listen=None):
            listen = listen or port
            name = "fleet-image-test-" + secrets.token_hex(6)
            names.append(name)
            # generic: only the shared-platform S3_* names, as a hosting inventory supplies them.
            storage = ({"S3_BUCKET": bucket, "S3_ENDPOINT": endpoint, "S3_REGION": "us-east-1",
                        "S3_ACCESS_KEY_ID": "test", "S3_SECRET_ACCESS_KEY": "test"}
                       if generic else
                       {"FLEET_S3_BUCKET": bucket, "FLEET_S3_ENDPOINT": endpoint,
                        "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
                        "AWS_REGION": "us-east-1"})
            env = {"FLEET_ADMIN_TOKEN": token, "FLEET_S3_PREFIX": "container-test",
                   "PORT": str(listen), "FLEET_STARTUP_TIMEOUT_SECONDS": "10",
                   "FLEET_OWNERSHIP_RENEW_SECONDS": "1", "FLEET_OWNERSHIP_EXPIRE_SECONDS": "15",
                   **storage}
            args = ["run", "-d", "--name", name, "--network", "host"]
            for key, value in env.items():
                args.extend(["-e", f"{key}={value}"])
            docker(*args, image)
            return name

        def healthy(at):
            try:
                with urlopen(at + "/health", timeout=1) as response:
                    return response.status == 200
            except OSError:
                return False

        def ready(name, at=None):
            at = at or base
            for _ in range(600):
                if docker("inspect", "-f", "{{.State.Running}}", name) != "true":
                    raise RuntimeError("container exited before readiness: " + docker("logs", name))
                try:
                    with urlopen(at + "/health", timeout=1) as response:
                        if response.status == 200 and json.load(response) == {"ok": True}:
                            return
                except OSError:
                    pass
                time.sleep(0.1)
            raise RuntimeError("container readiness timed out")

        def settings(method="GET", body=None, at=None):
            request = Request((at or base) + "/v1/settings/fleet", method=method,
                              headers={"Authorization": "Bearer " + token,
                                       "Content-Type": "application/json"},
                              data=None if body is None else json.dumps(body).encode())
            with urlopen(request, timeout=5) as response:
                assert response.status == 200
                return response.read().decode()

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
        settings("PUT", {"heartbeat": {"intervalSeconds": 91}})
        stop(name)
        docker("start", name)
        ready(name)
        assert "91" in settings(), "ordinary restart lost settings"
        stop(name)
        docker("rm", name)
        # Entire local filesystem is gone; same prefix restores the durable replica,
        # configured through the generic S3_* names Litestream must still receive.
        name = start("fleet-container-test", generic=True)
        ready(name)
        assert "91" in settings(), "replacement failed to restore settings"
        stop(name)
        docker("rm", name)

        # Rolling deploy as the platform does it: the new container starts while the
        # old one still serves writes. The old one hands over and stays as a standby.
        old = start("fleet-container-test")
        ready(old)
        new_port = free_port()
        new_base = f"http://127.0.0.1:{new_port}"
        new = start("fleet-container-test", listen=new_port)
        acknowledged, value, refused = None, 200, 0
        for _ in range(1200):
            if healthy(new_base):
                break
            try:
                settings("PUT", {"heartbeat": {"intervalSeconds": value}})
                acknowledged = value
            except OSError:
                refused += 1
            value += 1
            time.sleep(0.05)
        else:
            raise RuntimeError("new container never took over: " + docker("logs", new))
        assert refused > 0, "old writer never paused writes during hand-over"
        assert f'"intervalSeconds":{acknowledged}' in settings(at=new_base).replace(" ", ""), \
            "acknowledged write lost in hand-over"
        assert docker("inspect", "-f", "{{.State.Running}}", old) == "true", "old container must stay as standby"
        stop(old)
        stop(new)
        docker("rm", old, new)

        denied = start("fleet-container-denied")
        assert docker("wait", denied) != "0", "denied writes must fail startup"
        try:
            with urlopen(base + "/health", timeout=1):
                raise AssertionError("write-denied container accepted traffic")
        except OSError:
            pass
        print("PASS: configuration refusal, readiness, graceful stop, restart, fresh restore via S3_* names, rolling hand-over, denied writes")
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        service.terminate()
        service.wait(timeout=10)


if __name__ == "__main__":
    main()
