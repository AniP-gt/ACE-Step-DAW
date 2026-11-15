#!/usr/bin/env python3
"""Owned deterministic HTTP fixture for native generation processor probes."""
import argparse
import hashlib
import http.server
import io
import json
import os
import pathlib
import socket
import socketserver
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Fixture:
    def __init__(self, scenario="normal", output=None):
        self.scenario = scenario
        self.output = output
        self.injected = False
        self.lock = threading.Lock()
        self.counts = {}
        self.requests = {}
        self.clients = {}
        self.captured = bytearray()
        self.capture_ready = False
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setnchannels(2)
            wav.setsampwidth(4)
            wav.setframerate(48000)
            wav.writeframes(struct.pack('<ii', 268435456, 268435456) * 48000)
        self.audio = audio.getvalue()

    def handler(self):
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, data, status=200):
                data = data if isinstance(data, bytes) else json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def dispatch(self):
                path = urllib.parse.urlparse(self.path)
                key = self.command + ' ' + path.path
                with fixture.lock:
                    fixture.counts[key] = fixture.counts.get(key, 0) + 1
                    raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                    body = json.loads(raw) if raw and self.command != 'PUT' else {}
                    result, status = fixture.handle(self.command, path, body, raw)
                if fixture.scenario == 'generation-unknown' and self.command == 'POST' and path.path == '/v1/native-requests' and body.get('kind') == 'generation':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                if fixture.scenario == 'generation-unknown' and self.command == 'GET' and path.path == '/v1/native-requests':
                    time.sleep(2)
                inject = False
                if self.command == 'POST' and path.path == '/v1/native-requests' and body.get('kind') == 'prepare' and not fixture.injected:
                    fixture.injected = True
                    inject = True
                if inject and fixture.scenario in ('prepare-uncertain', 'prepare-uncertain-tuple', 'prepare-uncertain-malformed'):
                    if fixture.scenario == 'prepare-uncertain-tuple':
                        return self.reply({**result, 'sessionId': 'foreign-session'})
                    if fixture.scenario == 'prepare-uncertain-malformed':
                        return self.reply(b'{invalid')
                    return self.reply({'error': {'message': 'temporary unavailable'}}, 503)
                if inject and fixture.scenario == 'lost':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                if inject and fixture.scenario == 'malformed':
                    return self.reply(b'{invalid')
                if inject and fixture.scenario == 'oversize':
                    return self.reply(b' ' * (256 * 1024 + 1))
                if inject and fixture.scenario in ('late-pair', 'late-restore'):
                    (fixture.output / 'prepare-started').write_text('accepted before delay\n')
                    time.sleep(2)
                if inject and fixture.scenario == 'stall':
                    time.sleep(6)
                self.reply(result, status)

            do_GET = dispatch
            do_POST = dispatch
            do_PUT = dispatch

        return Handler

    def handle(self, method, url, body, raw):
        path = url.path
        if method == 'POST' and path == '/v1/pairings/claim':
            return {'sessionId': 'fixture-session', 'role': 'native', 'token': 'fixture-token'}, 200
        if method == 'POST' and path == '/v1/captures':
            self.captured.clear()
            self.capture_ready = False
            return {'captureId': 'fixture-capture'}, 200
        if method == 'PUT' and path.startswith('/v1/captures/'):
            self.captured.extend(raw)
            return {}, 200
        if method == 'POST' and path.endswith('/finalize'):
            assert hashlib.sha256(self.captured).hexdigest() == body['sha256']
            self.capture_ready = True
            return {'state': 'ready', 'canonicalFrameCount': 48000}, 200
        if method == 'GET' and path == '/v1/native-readiness':
            if self.scenario == 'prepare-accepted-failed' and any(r['kind'] == 'prepare' and r['state'] == 'failed' for r in self.requests.values()):
                self.failed_readiness_calls = getattr(self, 'failed_readiness_calls', 0) + 1
                return {'error': {'message': 'fixture readiness unavailable'}}, 503
            prepared = next((r for r in self.requests.values() if r['kind'] == 'prepare' and r['state'] == 'prepared'), None)
            return {'preparedRequestId': prepared['requestId'] if prepared else None, 'ready': bool(prepared), 'instruments': ['piano', 'violin'], **({} if prepared else {'reason': 'REFERENCE_UNAVAILABLE'})}, 200
        if method == 'POST' and path == '/v1/native-requests':
            if body['kind'] == 'prepare' and not self.capture_ready:
                return {'error': {'message': 'Capture is not ready'}}, 409
            if ((self.scenario == 'prepare-reject' or self.scenario.startswith('post-reject-')) and body['kind'] == 'prepare' and self.requests) or (self.scenario == 'generation-reject' and body['kind'] == 'generation'):
                return {'error': {'message': 'fixture rejection'}}, 409
            client = body['clientRequestId']
            if client in self.clients:
                return self.requests[self.clients[client]], 200
            request_id = ('prep-A01-fixture' if not self.requests else 'prep-B02-fixture') if self.scenario == 'prepare-accepted-failed' else 'fixture-request-' + str(len(self.requests) + 1)
            receipt = {'requestId': request_id, 'sessionId': body['sessionId'], 'projectId': 'fixture-project', 'captureId': 'fixture-capture', 'kind': body['kind'], 'state': 'pending'}
            if body['kind'] == 'prepare':
                if self.scenario == 'prepare-accepted-failed' and self.requests:
                    receipt.update(state='failed', error='fixture accepted failure')
                else:
                    receipt.update(state='prepared', bindingId='fixture-binding')
            else:
                receipt.update(state='submitted', preparedRequestId=body['preparedRequestId'], bindingId='fixture-binding', instrument=body['instrument'], prompt=body['prompt'].strip() and body['prompt'] or 'Add an instrumental layer', jobId='fixture-job')
            self.requests[request_id] = receipt
            self.clients[client] = request_id
            return receipt, 200
        if path == '/v1/native-requests' and method == 'GET':
            if self.scenario.startswith('prepare-uncertain') and not (self.output / 'allow-pending').exists():
                self.uncertain_lookups = getattr(self, 'uncertain_lookups', 0) + 1
                if self.uncertain_lookups >= 2:
                    (self.output / 'uncertain-lookups').write_text(str(self.uncertain_lookups))
                return {'error': {'message': 'not found'}}, 404
            client = urllib.parse.parse_qs(url.query).get('clientRequestId', [''])[0]
            if client in self.clients:
                receipt = self.requests[self.clients[client]]
                if self.scenario.startswith('prepare-uncertain') and not (self.output / 'allow-prepared').exists():
                    return {**receipt, 'state': 'pending'}, 200
                return receipt, 200
        if path.startswith('/v1/native-requests/'):
            parts = path.split('/')
            receipt = self.requests.get(parts[3])
            if receipt:
                if self.scenario.startswith('prepare-uncertain') and method == 'GET' and not (self.output / 'allow-prepared').exists():
                    return {**receipt, 'state': 'pending'}, 200
                if method == 'POST' and parts[-1] == 'cancel':
                    if receipt['state'] == 'pending':
                        receipt['state'] = 'canceled'
                    self.canceled = True
                return receipt, 200
        if method == 'GET' and path == '/v1/jobs/fixture-job':
            if self.scenario == 'prompt-limit-active':
                return {'jobId': 'fixture-job', 'state': 'running', 'backendOccupancy': 'occupied'}, 200
            if self.scenario.startswith('post-reject-'):
                mode = self.scenario.removeprefix('post-reject-')
                state = 'running' if mode == 'unknown' else mode
                return {'jobId': 'fixture-job', 'state': state, 'backendOccupancy': 'unknown' if mode == 'unknown' else 'occupied' if mode == 'running' else 'released', 'resultId': 'fixture-result', 'error': 'New job recovery cause'}, 200
            if self.scenario in ('job-failed', 'job-failed-object'):
                error = 'Model unavailable; check ACE-Step DAW model configuration and retry' if self.scenario == 'job-failed' else {'message': 'do not stringify object'}
                return {'jobId': 'fixture-job', 'state': 'failed', 'backendOccupancy': 'released', 'error': error}, 200
            return {'jobId': 'fixture-job', 'state': 'canceled' if getattr(self, 'canceled', False) else 'running' if self.scenario == 'cancel' else 'ready', 'backendOccupancy': 'released' if getattr(self, 'canceled', False) or self.scenario != 'cancel' else 'occupied', 'resultId': 'fixture-result'}, 200
        if method == 'GET' and path == '/v1/results/fixture-result':
            return {'resultId': 'fixture-result', 'assetId': 'fixture-asset', 'sha256': hashlib.sha256(self.audio).hexdigest(), 'frameCount': 48000, 'placementSeconds': -1.25}, 200
        if method == 'GET' and path == '/v1/assets/fixture-asset':
            return self.audio, 200
        if method == 'GET' and path == '/v1/results':
            return {'sessionId': 'fixture-session', 'results': [], 'nextBeforeResultId': None}, 200
        return {'error': {'message': 'not found'}}, 404


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--probe', type=pathlib.Path)
    parser.add_argument('--scenario', choices=['normal', 'lost', 'malformed', 'oversize', 'stall', 'cancel', 'prepare-reject', 'generation-reject', 'late-pair', 'late-restore', 'generation-unknown', 'mode-reopen', 'prepare-accepted-failed', 'job-failed', 'job-failed-object', 'post-reject-running', 'post-reject-ready', 'post-reject-failed', 'post-reject-unknown', 'prepare-uncertain', 'prepare-uncertain-tuple', 'prepare-uncertain-malformed', 'prompt-limit', 'prompt-limit-active'], default='normal')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    fixture = Fixture(args.scenario, args.output)
    server = Server(('127.0.0.1', 0), fixture.handler())
    port = server.server_port
    (args.output / 'resource.json').write_text(json.dumps({'pid': os.getpid(), 'port': port, 'address': '127.0.0.1'}))
    worker = threading.Thread(target=server.serve_forever)
    worker.start()
    try:
        base = 'http://127.0.0.1:' + str(port) + '/v1/'
        def call(path, payload=None):
            data = None if payload is None else json.dumps(payload).encode()
            request = urllib.request.Request(base + path, data=data, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer fixture-token'})
            with urllib.request.urlopen(request, timeout=3) as response:
                content = response.read()
                return json.loads(content) if response.headers.get_content_type() != 'audio/wav' and not content.startswith(b'RIFF') else content
        if args.self_test:
            assert not call('native-readiness?sessionId=fixture-session')['ready']
            try:
                call('native-requests', {'kind': 'prepare', 'sessionId': 'fixture-session', 'captureId': 'fixture-capture', 'clientRequestId': 'premature'})
                raise AssertionError('unfinalized capture was accepted')
            except urllib.error.HTTPError as error:
                assert error.code == 409
            pcm = struct.pack('<ff', 0.25, 0.25) * 48000
            call('captures', {'expectedFrames': 48000})
            put = urllib.request.Request(base + 'captures/fixture-capture/chunks/0', data=pcm, method='PUT')
            with urllib.request.urlopen(put, timeout=3) as response:
                assert response.status == 200
            assert call('captures/fixture-capture/finalize', {'sha256': hashlib.sha256(pcm).hexdigest()})['state'] == 'ready'
            prep = call('native-requests', {'kind': 'prepare', 'sessionId': 'fixture-session', 'captureId': 'fixture-capture', 'clientRequestId': 'client-prepare'})
            assert prep['state'] == 'prepared' and prep['bindingId'] == 'fixture-binding'
            assert call('native-requests?sessionId=fixture-session&clientRequestId=client-prepare') == prep
            assert call('native-readiness?sessionId=fixture-session')['preparedRequestId'] == prep['requestId']
            generation = call('native-requests', {'kind': 'generation', 'sessionId': 'fixture-session', 'preparedRequestId': prep['requestId'], 'instrument': 'piano', 'prompt': '', 'clientRequestId': 'client-generate'})
            assert generation['prompt'] == 'Add an instrumental layer' and generation['state'] == 'submitted'
            assert call('jobs/fixture-job')['backendOccupancy'] == 'released'
            audio = call('assets/fixture-asset')
            assert hashlib.sha256(audio).hexdigest() == call('results/fixture-result')['sha256']
            call('native-requests/' + generation['requestId'] + '/cancel', {})
            assert call('jobs/fixture-job')['state'] == 'canceled'
            assert fixture.counts['POST /v1/native-requests'] == 3
            print('PASS: readiness, owner lookup, prepare, generation, job, cancel, WAV and request counts')
        elif args.probe:
            result = subprocess.run([str(args.probe.resolve()), '--generation-prompt-limit-active' if args.scenario == 'prompt-limit-active' else '--generation-prompt-limit' if args.scenario == 'prompt-limit' else '--generation-prepare-uncertain' if args.scenario.startswith('prepare-uncertain') else '--generation-post-reject-' + args.scenario.removeprefix('post-reject-') if args.scenario.startswith('post-reject-') else '--generation-job-failed-object' if args.scenario == 'job-failed-object' else '--generation-job-failed' if args.scenario == 'job-failed' else '--generation-prepare-accepted-failed' if args.scenario == 'prepare-accepted-failed' else '--mode-reopen' if args.scenario == 'mode-reopen' else '--generation-unknown' if args.scenario == 'generation-unknown' else '--generation-late-pair' if args.scenario == 'late-pair' else '--generation-late-restore' if args.scenario == 'late-restore' else '--generation-cancel' if args.scenario == 'cancel' else '--generation-prepare-reject' if args.scenario == 'prepare-reject' else '--generation-reject' if args.scenario == 'generation-reject' else '--generation', str(port), str(args.output.resolve())], check=False, timeout=90)
            if result.returncode:
                raise SystemExit(result.returncode)
            assert fixture.counts.get('POST /v1/native-requests') == (1 if args.scenario in ('late-pair', 'late-restore', 'mode-reopen', 'prompt-limit') or args.scenario.startswith('prepare-uncertain') else 3 if args.scenario.startswith('post-reject-') else 2), fixture.counts
            if args.scenario in ('lost', 'malformed', 'oversize', 'stall', 'generation-unknown'):
                assert fixture.counts.get('GET /v1/native-requests', 0) >= 1, fixture.counts
            if args.scenario == 'prompt-limit-active':
                assert sum(receipt['kind'] == 'generation' for receipt in fixture.requests.values()) == 1
            if args.scenario == 'prompt-limit':
                assert len(fixture.requests) == 1 and all(receipt['kind'] == 'prepare' for receipt in fixture.requests.values())
                assert not any(key.startswith('GET /v1/assets/') or key.startswith('GET /v1/results/') for key in fixture.counts)
            if args.scenario.startswith('prepare-uncertain'):
                assert getattr(fixture, 'uncertain_lookups', 0) >= 2 and len(fixture.clients) == 1
                assert all(receipt['kind'] == 'prepare' for receipt in fixture.requests.values())
                assert not any(key.startswith('GET /v1/assets/') or key.startswith('GET /v1/results/') for key in fixture.counts)
            if args.scenario in ('job-failed', 'job-failed-object'):
                assert sum(receipt['kind'] == 'generation' for receipt in fixture.requests.values()) == 1
                assert not any(key.startswith('GET /v1/assets/') or key.startswith('GET /v1/results/') for key in fixture.counts)
            if args.scenario == 'prepare-accepted-failed':
                assert getattr(fixture, 'failed_readiness_calls', 0) >= 1
                (args.output / 'post-failure-readiness.txt').write_text(str(fixture.failed_readiness_calls))
            if args.scenario == 'cancel':
                assert fixture.counts.get('POST /v1/native-requests/fixture-request-2/cancel') == 1, fixture.counts
            ui = subprocess.run([str(args.probe.resolve()), '--generation-ui', str(port), str(args.output.resolve())], check=False, timeout=30)
            if ui.returncode:
                raise SystemExit(ui.returncode)
        else:
            parser.error('use --self-test or --probe')
        (args.output / 'counts.json').write_text(json.dumps(fixture.counts, indent=2, sort_keys=True))
    finally:
        (args.output / 'counts-final.json').write_text(json.dumps(fixture.counts, indent=2, sort_keys=True))
        server.shutdown()
        server.server_close()
        worker.join()
        with socket.socket() as check:
            check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            check.bind(('127.0.0.1', port))
        (args.output / 'teardown.txt').write_text('server stopped; port rebound successfully\n')


if __name__ == '__main__':
    main()
