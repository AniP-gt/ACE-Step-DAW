"""Exercise the actual native processor against an isolated running service."""
import json
import pathlib
import subprocess
import sys
import urllib.request
root = pathlib.Path(sys.argv[1])
probe = sys.argv[2]
token = (root / 'control-token').read_text().strip()
def request(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:5176/v1' + path, data=None if body is None else json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'X-Bridge-Protocol': '1', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as response:
        return json.load(response)
session = request('/sessions', {'name': 'Native processor fixture'})
pairing = request('/pairings', {'sessionId': session['sessionId'], 'role': 'native'})
result = subprocess.run([probe, pairing['code']], capture_output=True, text=True, timeout=30)
print(result.stdout)
print(result.stderr)
assert result.returncode == 0, result.returncode
captures = request('/captures?sessionId=' + session['sessionId'])['captures']
assert len(captures) == 1
capture = captures[0]
assert capture['state'] == 'ready'
assert capture['receivedFrames'] == capture['canonicalFrameCount'] == 48000
assert capture['hostStartSample'] == 0
print(json.dumps({'captureId': capture['captureId'], 'state': capture['state'], 'originalFrames': capture['receivedFrames'], 'canonicalFrames': capture['canonicalFrameCount'], 'canonicalSha256': capture['canonicalSha256']}, indent=2))
