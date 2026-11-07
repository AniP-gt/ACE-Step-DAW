"""Run with the real bridge service stopped by its owner; never stops that service."""
import hashlib
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time

finalize_delay_seconds = 8
stopping = threading.Event()
received = bytearray()
observed = {'finalizeDelaySeconds': finalize_delay_seconds}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def body(self):
        return self.rfile.read(int(self.headers.get('Content-Length', 0)))

    def send_json(self, data):
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        data = json.loads(self.body() or b'{}')
        if self.path == '/v1/pairings/claim':
            self.send_json({'token': 'fixture-token', 'sessionId': 'fixture-session', 'role': 'native'})
        elif self.path == '/v1/captures':
            assert data['expectedFrames'] == 48000 and data['channels'] == 2
            self.send_json({'captureId': 'fixture-capture'})
        elif self.path == '/v1/captures/fixture-capture/finalize':
            assert len(received) == 48000 * 2 * 4
            assert data['sha256'] == hashlib.sha256(received).hexdigest()
            observed['finalizeReceived'] = True
            observed['receivedFrames'] = len(received) // 8
            started = time.monotonic()
            if not stopping.wait(finalize_delay_seconds):
                observed['responseDelaySeconds'] = round(time.monotonic() - started, 3)
                self.send_json({'captureId': 'fixture-capture', 'state': 'ready'})
        elif self.path == '/v1/captures/fixture-capture/cancel':
            observed['cancelRequested'] = True
            self.send_json({'state': 'canceled'})
        else:
            self.send_error(404)

    def do_PUT(self):
        payload = self.body()
        assert self.path == '/v1/captures/fixture-capture/chunks/0'
        assert self.headers['X-Start-Frame'] == '0'
        assert self.headers['X-Chunk-SHA256'] == hashlib.sha256(payload).hexdigest()
        received.extend(payload)
        self.send_json({'receivedFrames': len(received) // 8})

class LoopbackServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = 'localhost'
        self.server_port = self.server_address[1]

server = LoopbackServer(('127.0.0.1', 5176), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
started = time.monotonic()
try:
    result = subprocess.run([sys.argv[1], 'fixture-pairing-code'], capture_output=True, text=True, timeout=25)
    observed['nativeExitCode'] = result.returncode
    observed['nativeElapsedSeconds'] = round(time.monotonic() - started, 3)
    print(result.stdout, end='', flush=True)
    print(result.stderr, end='', flush=True)
    print(json.dumps(observed, indent=2), flush=True)
    if not observed.get('finalizeReceived'):
        raise SystemExit('Native worker did not reach finalize')
    raise SystemExit(result.returncode)
finally:
    stopping.set()
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
