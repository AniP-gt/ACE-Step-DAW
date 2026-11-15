#!/usr/bin/env python3
"""Drive the real AU processor/editor against an isolated direct-Cover bridge fixture."""
import hashlib
import http.server
import io
import json
import os
import pathlib
import socketserver
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid
import wave
from urllib.parse import urlparse, parse_qs

probe = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
result_id = str(uuid.uuid4())
bad_id = str(uuid.uuid4())
lost_response = '--lost-response' in sys.argv[3:]
race = '--race' in sys.argv[3:]
recovery = '--recovery' in sys.argv[3:]
limit_kind = next((x.removeprefix('--limits-') for x in sys.argv[3:] if x.startswith('--limits-')), None)
limit_target = next((x.removeprefix('--target-') for x in sys.argv[3:] if x.startswith('--target-')), 'submit')
stream = io.BytesIO()
with wave.open(stream, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(4)
    w.setframerate(48000)
    w.writeframes(struct.pack('<ii', 268435456, 268435456) * 48000)
audio = stream.getvalue()

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class Handler(http.server.BaseHTTPRequestHandler):
    submissions = []
    jobs = {}
    captured = bytearray()
    interrupted_observations = 0
    reconcile_count = 0
    lock = threading.Lock()
    lookups = 0
    fetches = 0
    injected = False
    def log_message(self, *_args):
        pass
    def reply(self, data, status=200):
        data = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def inject_limit(self, data):
        type(self).injected = True
        (out / 'limit-started').write_text(limit_target)
        data = dict(data)
        data['padding'] = 'x' * (300000 if limit_kind == 'oversize' else 180000)
        encoded = json.dumps(data).encode()
        if limit_kind == 'malformed':
            return self.reply(b'{invalid')
        if limit_kind == 'oversize':
            return self.reply(encoded)
        self.send_response(200)
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        try:
            for index in range(8):
                self.wfile.write(encoded[index * len(encoded) // 8:(index + 1) * len(encoded) // 8])
                self.wfile.flush()
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def read_body(self):
        return self.rfile.read(int(self.headers.get('Content-Length', '0')))
    def do_PUT(self):
        body = self.read_body()
        with self.lock:
            self.captured.extend(body)
        self.reply({})
    def do_POST(self):
        payload = json.loads(self.read_body())
        path = urlparse(self.path).path
        if path == '/v1/pairings/claim':
            self.reply({'sessionId': 'fixture-session', 'role': 'native', 'token': 'fixture-token'})
        elif path == '/v1/captures':
            assert payload['expectedFrames'] == 48000
            self.reply({'captureId': 'fixture-capture'})
        elif path.endswith('/finalize'):
            assert hashlib.sha256(self.captured).hexdigest() == payload['sha256']
            self.reply({'state': 'ready', 'canonicalFrameCount': 48000})
        elif path == '/v1/direct-jobs':
            assert payload['sessionId'] == 'fixture-session' and payload['captureId'] == 'fixture-capture'
            assert payload['clientRequestId'] and payload['prompt']
            with self.lock:
                self.submissions.append(payload)
                job_id = 'fixture-job-' + str(len(self.submissions))
                self.jobs[job_id] = {'requestId': job_id, 'sessionId': 'fixture-session',
                    'captureId': 'fixture-capture', 'state': 'queued', 'start': time.monotonic(),
                    'fail': payload['prompt'] == 'fail fixture', 'bad': payload['prompt'] == 'bad wav fixture',
                    'recover': recovery and len(self.submissions) == 1}
                job = dict(self.jobs[job_id])
            if limit_kind == 'rejected':
                type(self).injected = True
                (out / 'limit-started').write_text(limit_target)
                self.reply({'error': {'message': 'fixture denied'}}, 409)
                return
            if limit_kind and limit_target == 'lookup':
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if limit_kind and limit_target == 'submit' and not self.injected:
                self.inject_limit({k: v for k, v in job.items() if k not in ('start', 'fail', 'bad', 'recover')})
                return
            if lost_response and len(self.submissions) == 1:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.reply({k: v for k, v in job.items() if k not in ('start', 'fail', 'bad', 'recover')})
        else:
            self.reply({'error': {'message': 'unexpected POST'}}, 404)
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/v1/direct-jobs':
            with self.lock:
                type(self).lookups += 1
            query = parse_qs(urlparse(self.path).query)
            with self.lock:
                match = next((j for j, payload in zip(self.jobs.values(), self.submissions) if payload['clientRequestId'] == query.get('clientRequestId', [None])[0]), None)
            if not match:
                self.reply({'error': {'message': 'not found'}}, 404)
            else:
                if limit_kind and limit_target == 'lookup' and not self.injected:
                    self.inject_limit({k: v for k, v in match.items() if k not in ('start', 'fail', 'bad', 'recover')})
                elif limit_kind:
                    time.sleep(2)
                    self.reply({'error': {'message': 'temporarily unavailable'}}, 503)
                else:
                    self.reply({k: v for k, v in match.items() if k not in ('start', 'fail', 'bad', 'recover')})
        elif path.startswith('/v1/direct-jobs/'):
            with self.lock:
                job = dict(self.jobs[path.rsplit('/', 1)[-1]])
            if limit_kind and limit_target == 'poll' and not self.injected:
                self.inject_limit({k: v for k, v in job.items() if k not in ('start', 'fail', 'bad', 'recover')})
                return
            if limit_kind:
                time.sleep(2)
                self.reply({'error': {'message': 'temporarily unavailable'}}, 503)
                return
            if job['recover']:
                # Only the fixture's explicit operator signal simulates control reconciliation.
                if (out / 'operator-reconcile').exists():
                    with self.lock:
                        assert len(self.submissions) == 1, 'automatic resubmission before recovery'
                        type(self).reconcile_count += 1
                    job['state'] = 'failed'
                else:
                    with self.lock:
                        type(self).interrupted_observations += 1
                    job['state'] = 'interrupted'
                job['error'] = 'SUBMISSION_OUTCOME_UNKNOWN'
            elif time.monotonic() - job['start'] > 2.8:
                job['state'] = 'failed' if job['fail'] else 'ready'
                if job['fail']:
                    job['error'] = 'fixture failure'
                else:
                    job['resultId'] = bad_id if job['bad'] else result_id
            else:
                job['state'] = 'running'
            self.reply({k: v for k, v in job.items() if k not in ('start', 'fail', 'bad', 'recover')})
        elif path == '/v1/results/' + result_id:
            type(self).fetches += 1
            self.reply({'resultId': result_id, 'assetId': 'fixture-asset', 'sha256': hashlib.sha256(audio).hexdigest(), 'frameCount': 48000, 'placementSeconds': 0})
        elif path == '/v1/results/' + bad_id:
            self.reply({'resultId': bad_id, 'assetId': 'fixture-asset', 'sha256': '0' * 64, 'frameCount': 48000, 'placementSeconds': 0})
        elif path == '/v1/assets/fixture-asset':
            self.reply(audio)
        elif path == '/v1/results':
            self.reply({'sessionId': 'fixture-session', 'results': [], 'nextBeforeResultId': None})
        else:
            self.reply({'error': {'message': 'unexpected GET'}}, 404)

server = Server(('127.0.0.1', 0), Handler)
(out / "resource.json").write_text(json.dumps({"pid": os.getpid(), "port": server.server_port, "address": "127.0.0.1"}))
worker = threading.Thread(target=server.serve_forever, daemon=True)
worker.start()
try:
    result = subprocess.run([str(probe), '--direct-limits' if limit_kind else '--direct-workflow', str(server.server_port), str(out)] + ([limit_kind, limit_target] if limit_kind else ['--recovery'] if recovery else ['--race'] if race else []), capture_output=True, text=True, timeout=40)
    print(result.stdout)
    print(result.stderr, file=sys.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)
    if limit_kind:
        assert len(Handler.submissions) == 1 and Handler.fetches == 0 and Handler.injected
        if limit_kind == 'rejected':
            assert Handler.lookups == 0
        print('PASS bounded Direct Cover', limit_kind, limit_target, 'one POST, no fetch')
    elif recovery:
        assert len(Handler.submissions) == 2, Handler.submissions
        assert [x['prompt'] for x in Handler.submissions] == ['solo violin, preserve melody'] * 2
        assert Handler.submissions[0]['clientRequestId'] != Handler.submissions[1]['clientRequestId']
        assert Handler.interrupted_observations >= 2 and Handler.reconcile_count >= 1
        assert (out / 'operator-reconcile').read_text() == 'operator explicitly reconciled backend'
        assert len(list(out.glob('*.png'))) == 21
        print('PASS explicit recovery: interrupted polls:', Handler.interrupted_observations,
              'operator reconcile:', Handler.reconcile_count, 'two distinct explicit POSTs')
    else:
        assert len(Handler.submissions) == 3, Handler.submissions
        assert [x['prompt'] for x in Handler.submissions] == ['solo violin, preserve melody', 'fail fixture', 'bad wav fixture']
        assert len(list(out.glob('direct-*.png'))) == 21
        print('PASS owned HTTP fixture: three explicit requests, one duplicate blocked, stereo PCM captured, 21 native editor snapshots; lost response:', lost_response, 'race:', race)
    assert len(Handler.captured) == 48000 * 2 * 4
finally:
    (out / 'counts.json').write_text(json.dumps({'submissions': len(Handler.submissions), 'lookups': Handler.lookups, 'fetches': Handler.fetches, 'injected': Handler.injected}))
    server.shutdown()
    server.server_close()
    worker.join()
    with socket.socket() as check:
        check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        check.bind(("127.0.0.1", server.server_port))
    (out / "teardown.txt").write_text("server stopped; port rebound successfully\n")
