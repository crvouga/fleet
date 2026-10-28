"""Exercise the production launcher against an ephemeral loopback S3 service.

Requires Bun, Litestream 0.5.17, and moto[server]==5.1.17 in this Python environment.
Never uses a real bucket or cloud credentials.
"""
import os
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

import boto3


def main():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}"
    service = subprocess.Popen(
        [sys.executable, "-m", "moto.server", "-H", "127.0.0.1", "-p", str(port)],
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
            raise RuntimeError("test object storage did not start")
        client = boto3.client("s3", endpoint_url=endpoint,
                              aws_access_key_id="test", aws_secret_access_key="test",
                              region_name="us-east-1")
        client.create_bucket(Bucket="fleet-recovery-test")
        client.create_bucket(Bucket="fleet-write-denied-test")
        client.put_bucket_policy(Bucket="fleet-write-denied-test", Policy=json.dumps({
            "Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Principal": "*",
                "Action": "s3:PutObject", "Resource": "arn:aws:s3:::fleet-write-denied-test/*"}]
        }))
        env = {**os.environ, "FLEET_TEST_DENIED_BUCKET": "fleet-write-denied-test", "FLEET_TEST_S3_BUCKET": "fleet-recovery-test",
               "FLEET_TEST_S3_ENDPOINT": endpoint,
               "FLEET_TEST_LITESTREAM_BIN": os.environ.get("FLEET_TEST_LITESTREAM_BIN", "litestream"),
               "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_REGION": "us-east-1"}
        result = subprocess.run(["bun", "test", "--timeout", "240000", "test/replication.test.ts", "test/ownership-replication.test.ts"],
                                cwd=Path(__file__).resolve().parents[1], env=env, check=False)
        return result.returncode
    finally:
        service.terminate()
        service.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(main())
