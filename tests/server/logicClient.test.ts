import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createBridgeService } from '../../server/logic-bridge/service';
import { callLogicService } from '../../server/logic-client';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connection() {
  const root = await mkdtemp(join(tmpdir(), 'logic-client-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = await createBridgeService({ root, port: 0 });
  cleanups.push(() => service.close());
  async function post(path: string, body: unknown, token = service.controlToken) {
    const response = await fetch(`${service.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Bridge-Protocol': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected service object');
    return Object.fromEntries(Object.entries(value));
  }
  const session = await post('/sessions', { name: 'Client integration' });
  const pairing = await post('/pairings', { sessionId: session.sessionId, role: 'mcp', projectId: 'project-a' });
  const credential = await post('/pairings/claim', { code: pairing.code }, '');
  if (typeof credential.token !== 'string' || typeof session.sessionId !== 'string') throw new Error('Expected paired credential');
  vi.stubEnv('LOGIC_BRIDGE_URL', service.url);
  vi.stubEnv('LOGIC_BRIDGE_TOKEN', credential.token);
  vi.stubEnv('LOGIC_BRIDGE_SESSION_ID', session.sessionId);
  return { sessionId: session.sessionId, service, root };
}

it('reads captures through the authenticated service client and rejects a different session', async () => {
  const { sessionId } = await connection();
  await expect(callLogicService('logic_list_captures', { sessionId })).resolves.toEqual({ captures: [] });
  await expect(callLogicService('logic_list_captures', { sessionId: 'other-session' })).rejects.toThrow('Session does not match');
});

it('propagates missing-job errors and refuses a non-loopback service URL before sending credentials', async () => {
  const { sessionId } = await connection();
  await expect(callLogicService('logic_get_job', { sessionId, jobId: 'missing-job' })).rejects.toThrow('HTTP 404');
  vi.stubEnv('LOGIC_BRIDGE_URL', 'http://example.com/v1');
  await expect(callLogicService('logic_list_captures', { sessionId })).rejects.toThrow('loopback HTTP');
});

it('pairs through the shipped CLI and uses its private credential file for authenticated capture discovery', async () => {
  const { service, root } = await connection();
  const credentialFile = join(root, 'paired-mcp.json');
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/logic-pair.ts', 'CLI session', 'project-cli', credentialFile], {
    env: { ...process.env, LOGIC_BRIDGE_ROOT: root, LOGIC_BRIDGE_URL: service.url },
  });
  const output: unknown = JSON.parse(stdout);
  if (typeof output !== 'object' || output === null || !('sessionId' in output) || typeof output.sessionId !== 'string') throw new Error('Expected paired session');
  expect(stdout).not.toContain('"token"');
  vi.stubEnv('LOGIC_BRIDGE_TOKEN', '');
  vi.stubEnv('LOGIC_BRIDGE_SESSION_ID', output.sessionId);
  vi.stubEnv('LOGIC_BRIDGE_CREDENTIAL_FILE', credentialFile);
  await expect(callLogicService('logic_list_captures', { sessionId: output.sessionId })).resolves.toEqual({ captures: [] });
});

it('serves a real Logic MCP call without opening a browser WebSocket', async () => {
  const { sessionId } = await connection();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/mcp-server.ts'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const answer = once(child.stdout, 'data');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'logic_list_captures', arguments: { sessionId } } }) + '\n');
    const [chunk] = await answer;
    const response: unknown = JSON.parse(String(chunk));
    expect(response).toMatchObject({ id: 9, result: { content: [{ type: 'text', text: JSON.stringify({ captures: [] }, null, 2) }] } });
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});
