#!/usr/bin/env python3
"""Drive the actual processor against an owned loopback service."""
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time
import uuid
import hashlib
import io
import pathlib
import struct
import wave
from urllib.parse import urlparse, parse_qs

UI = len(sys.argv) > 2 and sys.argv[2] == "--ui"
NATIVE = len(sys.argv) > 2 and sys.argv[2] == "--native"
ui_id = str(uuid.uuid4())
cache = pathlib.Path.home() / 'Library/ACE-Step Bridge/native-results'
before_sidecars = set(cache.rglob('*.json')) if UI and cache.exists() else set()
wave_stream = io.BytesIO()
with wave.open(wave_stream, 'wb') as writer:
    writer.setnchannels(2); writer.setsampwidth(4); writer.setframerate(48000)
    writer.writeframes(struct.pack('<ii', 268435456, 268435456) * 128)
wave_bytes = wave_stream.getvalue()

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class Handler(http.server.BaseHTTPRequestHandler):
    calls = 0
    hidden_requests = 0
    detail_seen = False
    after_detail = 0
    lock = threading.Lock()
    def log_message(self, *_args):
        pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if UI and payload.get('code') == 'slow-pair': time.sleep(1)
        session = 'new-session' if payload.get('code') == 'new-session' else 'fixture-session'
        data = json.dumps({'role': 'native', 'token': 'fixture-token', 'sessionId': session}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        with self.lock:
            type(self).calls += 1
            call = type(self).calls
        if (UI or NATIVE) and pathlib.Path(sys.argv[3], 'hidden-marker').exists(): type(self).hidden_requests += 1
        if NATIVE: pathlib.Path(sys.argv[3], 'request-count').write_text(str(call))
        print(f'{time.monotonic():.3f} catalog request {call}', flush=True)
        if NATIVE:
            body=json.dumps({'sessionId':'fixture-session','results':[], 'nextBeforeResultId':None}).encode()
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
        path = urlparse(self.path).path
        if UI and path.startswith('/v1/assets/'):
            self.send_response(200); self.send_header('Content-Length',str(len(wave_bytes))); self.end_headers(); self.wfile.write(wave_bytes); return
        if UI and path.startswith('/v1/results/'):
            type(self).detail_seen = True
            metadata={'resultId':ui_id,'assetId':'fixture-asset','sha256':hashlib.sha256(wave_bytes).hexdigest(),'frameCount':128,'placementSeconds':-2.5}
            payload=json.dumps(metadata).encode(); self.send_response(200); self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload); return
        if UI and type(self).detail_seen:
            type(self).after_detail += 1
            if type(self).after_detail >= 6:
                self.send_response(500); self.send_header('Content-Length', '0'); self.end_headers(); return
        if UI:
            query = parse_qs(urlparse(self.path).query)
            if call == 2: time.sleep(0.8)
            def row(number, instrument, order):
                return {'resultId': f'{number*8}-{number*4}-4{number*3}-8{number*3}-{number*12}', 'jobId':'job', 'instrument':instrument, 'frameCount':48000*order, 'placementSeconds':-1.25*order, 'publicationOrder':order}
            rows = [] if call == 1 else [row('3','Strings',1)] if query.get('beforeResultId') else [row('1','Piano',3),dict(row('2','Guitar',2), resultId=ui_id)]
            body = json.dumps({'sessionId':'fixture-session','results':rows,'nextBeforeResultId':rows[-1]['resultId'] if len(rows)==2 else None}).encode()
        elif call == 1:
            body = json.dumps({'sessionId':'fixture-session','results':[{'resultId':'fixture-result','jobId':'job','instrument':'piano','frameCount':48000,'placementSeconds':0,'publicationOrder':1}],'nextBeforeResultId':None}).encode()
        elif call == 2:
            body = b'x' * (256 * 1024 + 1)
        elif call == 3:
            body = b'{invalid'
        elif call in (4, 10):
            self.send_response(200); self.send_header('Content-Length','100'); self.end_headers(); self.wfile.write(b'{'); self.wfile.flush()
            try:
                for _ in range(4):
                    time.sleep(2); self.wfile.write(b' '); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError): pass
            return
        else:
            if call in (5, 7): time.sleep(2)
            if call >= 8: time.sleep(1)
            session = 'fixture-session' if call == 5 else 'new-session'
            result = 'old-late' if call == 5 else 'hidden-late' if call == 7 else 'new-result'
            body = json.dumps({'sessionId':session,'results':[{'resultId':result,'jobId':'job','instrument':'piano','frameCount':48000,'placementSeconds':0,'publicationOrder':2}],'nextBeforeResultId':None}).encode()
        self.send_response(200); self.send_header('Content-Length',str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

try:
    server = Server(('127.0.0.1', 5176), Handler)
except OSError as exc:
    print(f'SKIP: port 5176 unavailable: {exc}', file=sys.stderr); sys.exit(2)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    result = subprocess.run([sys.argv[1], '--ui', sys.argv[3], ui_id] if UI else [sys.argv[1], sys.argv[3]] if NATIVE else [sys.argv[1], '--catalog'], timeout=100 if NATIVE else 35, check=False)
    print(f'processor exit {result.returncode}; requests {Handler.calls}', flush=True)
    if not UI and not NATIVE and result.returncode == 0 and Handler.calls != 10: result.returncode = 44
    if (UI or NATIVE) and result.returncode == 0 and Handler.hidden_requests != 0:
        print(f'FAIL hidden requests: {Handler.hidden_requests}', flush=True); result.returncode = 46
    if UI and result.returncode == 0 and not 13 <= Handler.calls <= 19:
        print('FAIL unexpected request count: possible missing or repeated visibility refresh', flush=True); result.returncode = 45
finally:
    server.shutdown(); server.server_close(); thread.join()
    print('owned fixture stopped and port closed', flush=True)
    if NATIVE:
        pathlib.Path(sys.argv[3], 'hidden-marker').unlink(missing_ok=True)
        pathlib.Path(sys.argv[3], 'request-count').unlink(missing_ok=True)
    if UI:
        pathlib.Path(sys.argv[3], 'hidden-marker').unlink(missing_ok=True)
        removed=[]
        for sidecar in set(cache.rglob('*.json')) - before_sidecars:
            try:
                if json.loads(sidecar.read_text()).get('resultId') == ui_id:
                    audio=sidecar.with_suffix('.wav'); audio.unlink(missing_ok=True); sidecar.unlink(); removed.append(str(audio))
            except (OSError, ValueError):
                pass
        print(f'fixture UUID {ui_id}; removed {len(removed)} exact-owned WAV/sidecar pairs: {removed}', flush=True)
        if any(pathlib.Path(path).exists() or pathlib.Path(path).with_suffix('.json').exists() for path in removed):
            raise RuntimeError('fixture cleanup incomplete')
sys.exit(result.returncode)
