import { request } from 'node:http';
import { readFile } from 'node:fs/promises';

class LogicBridgeError extends Error {
  override readonly name = 'LogicBridgeError';
}

export function isLogicServiceTool(tool: string): boolean {
  return ['logic_list_captures', 'logic_get_job', 'logic_cancel_job', 'logic_export_result'].includes(tool);
}

export async function callLogicService(tool: string, params: Record<string, unknown>): Promise<unknown> {
  let token = process.env.LOGIC_BRIDGE_TOKEN;
  let fileSession: string | undefined;
  const credentialFile = process.env.LOGIC_BRIDGE_CREDENTIAL_FILE;
  if (!token && credentialFile) {
    const credential: unknown = JSON.parse(await readFile(credentialFile, 'utf8'));
    if (typeof credential !== 'object' || credential === null || !('token' in credential) || typeof credential.token !== 'string' || !('sessionId' in credential) || typeof credential.sessionId !== 'string' || !('role' in credential) || credential.role !== 'mcp') {
      throw new LogicBridgeError('Invalid MCP credential file.');
    }
    token = credential.token;
    fileSession = credential.sessionId;
  }
  if (!token) throw new LogicBridgeError('Pair an MCP client and set LOGIC_BRIDGE_TOKEN before using Logic tools.');
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new LogicBridgeError('sessionId is required.');
  const configuredSession = process.env.LOGIC_BRIDGE_SESSION_ID ?? fileSession;
  if (configuredSession && sessionId !== configuredSession) throw new LogicBridgeError('Session does not match this MCP connection.');
  const base = new URL(process.env.LOGIC_BRIDGE_URL ?? 'http://127.0.0.1:5176/v1/');
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
    throw new LogicBridgeError('Logic bridge URL must be an unauthenticated loopback HTTP URL.');
  }
  base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
  let route: string;
  let method = 'GET';
  const id = (key: string): string => {
    const value = params[key];
    if (typeof value !== 'string' || !value) throw new LogicBridgeError(`${key} is required.`);
    return encodeURIComponent(value);
  };
  switch (tool) {
    case 'logic_list_captures': route = `captures?sessionId=${encodeURIComponent(sessionId)}`; break;
    case 'logic_get_job': route = `jobs/${id('jobId')}`; break;
    case 'logic_cancel_job': route = `jobs/${id('jobId')}/cancel`; method = 'POST'; break;
    case 'logic_export_result': route = `results/${id('resultId')}`; break;
    default: throw new LogicBridgeError(`Unsupported Logic service tool: ${tool}`);
  }
  return new Promise((resolve, reject) => {
    const req = request(new URL(route, base), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'x-bridge-protocol': '1', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    }, response => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) response.destroy(new LogicBridgeError('Bridge response exceeds metadata limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!response.statusCode || response.statusCode >= 400) {
          reject(new LogicBridgeError(`Bridge returned HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try { const value: unknown = JSON.parse(body); resolve(value); }
        catch (error) { reject(error instanceof Error ? error : new LogicBridgeError('Invalid bridge response.')); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new LogicBridgeError('Logic bridge request timed out.')));
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}
