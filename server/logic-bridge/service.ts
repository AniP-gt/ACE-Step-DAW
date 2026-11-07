import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { storage } from './storage';
import { routes } from './routes';
import { BridgeError, check, object, string } from './validation';
import { BRIDGE_PORT, type BridgeCredential } from '../../shared/logic-bridge/types';
interface Options { readonly root: string; readonly port?: number; readonly origins?: readonly string[]; readonly quotaBytes?: number }
function matches(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  const limit = request.url?.endsWith('/result') ? 64 * 1024 * 1024 : request.url?.includes('/chunks/') ? 1048576 : 65536;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length; check(length <= limit, 'BODY_TOO_LARGE', 'Request exceeds size limit', 413); chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function createBridgeService(options: Options) {
  const db = await storage(options.root);
  const dispatch = routes(db, options.root, options.quotaBytes ?? 10 * 1024 ** 3);
  const origins = options.origins ?? ['http://127.0.0.1:5174'];
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const subscribers = new Map<WebSocket, string>();
  const events = db.previousEvents.slice(-1000).map(value => {
    const event = object(value);
    check(typeof event.cursor === 'number' && Number.isSafeInteger(event.cursor), 'CORRUPT_JOURNAL', 'Invalid event cursor', 500);
    return { cursor: event.cursor, sessionId: string(event, 'sessionId', 'control'), type: string(event, 'type') };
  });
  let cursor = events.at(-1)?.cursor ?? 0;
  let tail: Promise<unknown> = Promise.resolve();
  let origin = '';
  const credential = (token: string): BridgeCredential | 'control' | undefined => matches(token, db.controlToken) ? 'control' : db.state.credentials.find(item => matches(token, item.token));
  const validateSurface = (request: IncomingMessage) => {
    check(request.headers.host === new URL(origin).host, 'INVALID_HOST', 'Untrusted Host', 403);
    check(!request.headers.origin || origins.includes(request.headers.origin), 'INVALID_ORIGIN', 'Untrusted Origin', 403);
  };
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const execute = async () => {
      try {
        validateSurface(request);
        const url = new URL(request.url ?? '/', origin);
        check(!url.searchParams.has('token'), 'INVALID_CREDENTIAL', 'Credentials must not be in URL');
        if (request.headers.origin) { response.setHeader('Access-Control-Allow-Origin', request.headers.origin); response.setHeader('Vary', 'Origin'); }
        if (request.method === 'OPTIONS') {
          response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
          response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Bridge-Protocol,X-Start-Frame,X-Chunk-SHA256,X-Executor-Id'); response.writeHead(204); response.end(); return;
        }
        if (url.pathname === '/v1/health' && request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ protocolVersion: 1, ready: true })); return; }
        check(url.pathname.startsWith('/v1/'), 'NOT_FOUND', 'Route missing', 404);
        const authenticated = credential((request.headers.authorization ?? '').replace(/^Bearer /, ''));
        check(authenticated || url.pathname === '/v1/pairings/claim', 'UNAUTHORIZED', 'Bearer credential required', 401);
        const mutating = request.method !== 'GET';
        if (mutating) check(request.headers['x-bridge-protocol'] === '1', 'PROTOCOL_MISMATCH', 'X-Bridge-Protocol: 1 required', 426);
        const bytes = await body(request);
        const result = await dispatch({ method: request.method ?? 'GET', url, credential: authenticated, bytes, headers: request.headers });
        if (mutating) {
          await db.save();
          const resultObject = Buffer.isBuffer(result) ? {} : object(result);
          const sessionId = typeof resultObject.sessionId === 'string' ? resultObject.sessionId : authenticated && authenticated !== 'control' ? authenticated.sessionId : 'control';
          const event = { cursor: ++cursor, sessionId, type: url.pathname };
          await db.journal(event); events.push(event); if (events.length > 1000) events.shift();
          for (const [socket, session] of subscribers) if (session === sessionId && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
        }
        response.statusCode = request.method === 'POST' && url.pathname === '/v1/jobs' ? 202 : 200;
        response.setHeader('Content-Type', Buffer.isBuffer(result) ? 'audio/wav' : 'application/json');
        response.end(Buffer.isBuffer(result) ? result : JSON.stringify(result));
      } catch (error) {
        const problem = error instanceof BridgeError ? error : error instanceof SyntaxError ? new BridgeError(400, 'INVALID_JSON', 'Invalid JSON') : new BridgeError(500, 'INTERNAL_ERROR', 'Bridge operation failed');
        response.statusCode = problem.status; response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: { code: problem.code, message: problem.message, retryable: problem.status >= 500, requestId } }));
      }
    };
    tail = tail.then(execute, execute);
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('upgrade', (request, socket, head) => {
    try { validateSurface(request); check(request.url === '/v1/events', 'NOT_FOUND', 'Unknown WebSocket route', 404); }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 3000);
      ws.once('close', () => { clearTimeout(timeout); subscribers.delete(ws); });
      ws.once('message', raw => {
        try {
          const message = object(JSON.parse(raw.toString()));
          const auth = credential(string(message, 'token'));
          check(auth && auth !== 'control', 'UNAUTHORIZED', 'Session token required', 401);
          check(message.protocolVersion === 1, 'PROTOCOL_MISMATCH', 'Protocol mismatch', 426);
          const requested = message.cursor ?? cursor;
          check(typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0 && requested <= cursor && requested >= (events[0]?.cursor ?? 1) - 1, 'CURSOR_EXPIRED', 'Refresh session snapshot', 409);
          clearTimeout(timeout); subscribers.set(ws, auth.sessionId);
          ws.send(JSON.stringify({ type: 'authenticated', cursor }));
          for (const event of events) if (event.cursor > requested && event.sessionId === auth.sessionId) ws.send(JSON.stringify(event));
        } catch { ws.close(1008, 'Authentication or cursor rejected'); }
      });
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? BRIDGE_PORT, '127.0.0.1', resolve); }); }
  catch (error) { sockets.close(); await db.close(); throw error; }
  const address = server.address();
  check(address && typeof address !== 'string', 'LISTEN_FAILED', 'Missing listener', 500);
  origin = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return { url: `${origin}/v1`, controlToken: db.controlToken, close: async () => {
    if (closed) return; closed = true;
    for (const socket of sockets.clients) socket.terminate(); sockets.close();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await tail; await db.close();
  } };
}
