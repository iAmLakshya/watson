#!/usr/bin/env python3
"""Use generated audio + an actual temporary encrypted-storage service, never live input."""
import argparse
import base64
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

parser=argparse.ArgumentParser(); parser.add_argument("--native",action="store_true"); parser.add_argument("--ui",action="store_true"); parser.add_argument("--result-bundle",default="RecordingLiveWorkflow.xcresult"); arguments=parser.parse_args()
ROOT=Path(__file__).resolve().parents[2]; IOS=ROOT/"ios"
with tempfile.TemporaryDirectory(prefix="watson-ios-audio-") as temporary:
    listener=socket.socket();listener.bind(("127.0.0.1",0));port=listener.getsockname()[1];listener.close()
    storage=Path(temporary)/"encrypted-recordings"
    environment={key:value for key,value in os.environ.items() if not key.startswith("WATSON_") and not key.startswith("TEST_RUNNER_WATSON_")}
    environment.update(WATSON_HOST="127.0.0.1",WATSON_PORT=str(port),WATSON_DB_PATH=str(Path(temporary)/"fixture.sqlite"),WATSON_PUBLIC_ORIGIN=f"http://127.0.0.1:{port}",WATSON_RECORDING_DIR=str(storage),WATSON_RECORDING_KEY=base64.b64encode(os.urandom(32)).decode())
    log=open(IOS/"evidence/recording-service.log","w")
    process=subprocess.Popen(["node",str(ROOT/"server/dist/main.js")],cwd=ROOT/"server",env=environment,stdout=log,stderr=log)
    try:
        for _ in range(100):
            if process.poll() is not None:raise RuntimeError("Temporary recording service exited")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health",timeout=.3):break
            except Exception:time.sleep(.1)
        else:raise RuntimeError("Recording fixture never became ready")
        address=f"http://127.0.0.1:{port}/api/v1"
        environment["WATSON_IOS_RECORDING_BACKEND"]=address;environment["WATSON_IOS_RECORDING_STORAGE"]=str(storage)
        with open(IOS/"evidence/recording-backend-integration.log","w") as output:
            result=subprocess.run(["swift","test","--filter","RecordingBackendIntegrationTests"],cwd=IOS,env=environment,stdout=output,stderr=subprocess.STDOUT)
        if result.returncode:raise SystemExit(result.returncode)
        if arguments.native or arguments.ui:
            environment["TEST_RUNNER_WATSON_IOS_RECORDING_BACKEND"]=address
            command=["xcodebuild","-project",str(IOS/"Watson.xcodeproj"),"-scheme","Watson","-sdk","iphonesimulator26.1","-destination","platform=iOS Simulator,id=F3131AA1-4473-4B7D-9D38-D2712CB5AA3B","-derivedDataPath",str(IOS/"build/DerivedData"),"-resultBundlePath",str(IOS/"evidence"/arguments.result_bundle),"-parallel-testing-enabled","NO","CODE_SIGNING_ALLOWED=NO","ONLY_ACTIVE_ARCH=YES","test"]
            if arguments.native:command.append("-only-testing:WatsonTests/NativeRecordingIntegrationTests")
            if arguments.ui:command.append("-only-testing:WatsonUITests/WatsonUITests/testActualCompleteRecordingUploadDownloadAndDelete")
            with open(IOS/"evidence/recording-native-workflow.log","w") as output:result=subprocess.run(command,cwd=ROOT,env=environment,stdout=output,stderr=subprocess.STDOUT)
            if result.returncode:raise SystemExit(result.returncode)
        print(json.dumps({"result":"passed","backend":"actual temporary Node/SQLite encrypted chunk storage","source":"generated real CAF segments; composed valid complete WAV","microphoneCaptures":0,"providerRequests":0,"emailsDelivered":0,"native":arguments.native,"ui":arguments.ui}))
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
