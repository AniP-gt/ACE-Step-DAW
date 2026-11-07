"""Own loopback port 5176 only while the real service is stopped by its owner."""
import hashlib
import http.server
import json
import os
import pathlib
import struct
import subprocess
import socketserver
import tempfile
import threading
import time
import uuid
import wave
import sys

cache = pathlib.Path.home() / 'Library/ACE-Step Bridge/native-results'
cache.mkdir(parents=True, exist_ok=True)
existing_sidecars = set(cache.rglob('*.json'))
run_id = uuid.uuid4().hex
delay_pair = '--pair-race' in sys.argv[2:]
result_a, result_b = 'race-A-' + run_id, 'race-B-' + run_id
file_b = cache / ('race-' + run_id + '.wav')
try:
    with tempfile.TemporaryDirectory(prefix='native-cache-race-', dir=os.environ.get('TMPDIR')) as temporary:
        directory = pathlib.Path(temporary)
        def write_wave(path, value):
            with wave.open(str(path), 'wb') as writer:
                writer.setnchannels(2)
                writer.setsampwidth(4)
                writer.setframerate(48000)
                writer.writeframes(struct.pack('<ii', value, value) * 128)
        write_wave(file_b, 268435456)
        write_wave(directory / 'A.wav', 536870912)
        bytes_a = (directory / 'A.wav').read_bytes()
        def metadata(result, payload):
            return {'resultId': result, 'assetId': 'fixture-asset', 'sha256': hashlib.sha256(payload).hexdigest(), 'frameCount': 128, 'placementSeconds': 0}
        file_b.with_suffix('.json').write_text(json.dumps(metadata(result_b, file_b.read_bytes())))
        (directory / 'config.json').write_text(json.dumps({'resultA': result_a, 'resultB': result_b, 'delayPair': delay_pair}))
        (directory / 'code').write_text('test-owned-pairing-code')
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def send(self, payload, content_type='application/json'):
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def pause_response(self):
                (directory / 'response-paused').write_text('paused')
                deadline = time.monotonic() + 10
                while not (directory / 'release-response').exists() and time.monotonic() < deadline:
                    time.sleep(0.005)
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                if delay_pair:
                    self.pause_response()
                self.send(json.dumps({'token': 'test-owned-token', 'sessionId': 'fixture', 'role': 'native'}).encode())
            def do_GET(self):
                if self.path == '/v1/results/' + result_a:
                    self.send(json.dumps(metadata(result_a, bytes_a)).encode())
                elif self.path.startswith('/v1/assets/'):
                    self.pause_response()
                    self.send(bytes_a, 'audio/wav')
                else:
                    self.send_error(404)
        class LoopbackServer(http.server.ThreadingHTTPServer):
            def server_bind(self):
                socketserver.TCPServer.server_bind(self)
                self.server_name = 'localhost'
                self.server_port = self.server_address[1]
        server = LoopbackServer(('127.0.0.1', 5176), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run([sys.argv[1], '--race-restore', str(directory), file_b.name], capture_output=True, text=True, timeout=25)
            print(result.stdout, end='', flush=True)
            print(result.stderr, end='', flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        if result.returncode:
            raise SystemExit(result.returncode)
finally:
    file_b.unlink(missing_ok=True)
    file_b.with_suffix('.json').unlink(missing_ok=True)
    for sidecar in set(cache.rglob('*.json')) - existing_sidecars:
        try:
            if json.loads(sidecar.read_text()).get('resultId') in (result_a, result_b):
                sidecar.with_suffix('.wav').unlink(missing_ok=True)
                sidecar.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
