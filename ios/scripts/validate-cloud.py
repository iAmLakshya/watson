#!/usr/bin/env python3
"""Exercise the Swift client against a temporary real Watson Node/SQLite server."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IOS = ROOT / "ios"
with tempfile.TemporaryDirectory(prefix="watson-ios-cloud-") as temporary:
    listener = socket.socket(); listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]; listener.close()
    # Do not inherit operator SMTP, billing, SSO, connector or production DB settings.
    environment = {key:value for key,value in os.environ.items() if not key.startswith("WATSON_")}
    environment.update(WATSON_HOST="127.0.0.1", WATSON_PORT=str(port), WATSON_DB_PATH=str(Path(temporary)/"fixture.sqlite"), WATSON_PUBLIC_ORIGIN=f"http://127.0.0.1:{port}")
    log = open(IOS/"evidence/cloud-service.log", "w")
    process = subprocess.Popen(["node", str(ROOT/"server/dist/main.js")], cwd=ROOT/"server", env=environment, stdout=log, stderr=log)
    try:
        for _ in range(100):
            if process.poll() is not None: raise RuntimeError("Temporary service exited; inspect ios/evidence/cloud-service.log")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=0.3): break
            except Exception: time.sleep(0.1)
        else: raise RuntimeError("Temporary service never became ready")
        environment["WATSON_IOS_TEST_BACKEND"] = f"http://127.0.0.1:{port}/api/v1"
        with open(IOS/"evidence/cloud-integration-tests.log", "w") as output:
            result = subprocess.run(["swift", "test", "--filter", "BackendIntegrationTests"], cwd=IOS, env=environment, stdout=output, stderr=subprocess.STDOUT)
        print(json.dumps({"result":"passed" if result.returncode == 0 else "failed", "exitCode":result.returncode, "backend":"actual Node/SQLite process in temporary directory", "providerRequests":0}))
        raise SystemExit(result.returncode)
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close()
