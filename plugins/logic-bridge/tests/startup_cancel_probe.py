#!/usr/bin/env python3
"""Exercise the real processor with a separately instrumented, owned JUCE copy."""
import http.server
import json
import pathlib
import socket
import subprocess
import sys
import threading
import time

class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        body=json.dumps({'role':'native','token':'startup-token','sessionId':'startup-session'}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        print(f'{time.monotonic():.6f} fixture received GET; withholding headers',flush=True)
        time.sleep(6)

if len(sys.argv)!=3:
    raise SystemExit('usage: startup_cancel_probe.py processor_probe gate_directory')
gate=pathlib.Path(sys.argv[2]);gate.mkdir(parents=True,exist_ok=True)
for name in ('entered','release','cancel'): (gate/name).unlink(missing_ok=True)
try: server=Server(('127.0.0.1',5176),Handler)
except OSError as exc: raise SystemExit(f'port 5176 unavailable: {exc}')
thread=threading.Thread(target=server.serve_forever);thread.start()
try:
    completed=subprocess.run([sys.argv[1],'--startup-cancel',str(gate)],timeout=15,check=False)
    print(f'processor exit {completed.returncode}',flush=True)
finally:
    server.shutdown();server.server_close();thread.join()
    print('owned server stopped and port closed',flush=True)
sys.exit(completed.returncode)
