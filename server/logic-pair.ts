import { request } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nativeOnly = args[0] === '--native-only' || args[0] === '--native-session';
  const existingSession = args[0] === '--native-session';
  const [name, projectId, outputFile] = nativeOnly ? [args[1], undefined, undefined] : args;
  if (!name?.trim() || (nativeOnly ? args.length !== 2 : !projectId || !outputFile)) {
    throw new Error('Usage: npm run bridge:pair -- --native-only <session-name>\n   or: npm run bridge:pair -- --native-session <session-id>\n   or: npm run bridge:pair -- <session-name> <DAW-project-id> <new-credential-file>');
  }
  const root = process.env.LOGIC_BRIDGE_ROOT ?? join(homedir(), 'Library/Application Support/ACE-Step Bridge');
  const secret = await readFile(join(root, 'control-token'), 'utf8');
  const base = new URL(process.env.LOGIC_BRIDGE_URL ?? 'http://127.0.0.1:5176/v1/');
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Pairing requires the loopback bridge.');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
  const post = (path: string, data: unknown, token: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-bridge-protocol': '1', 'content-type': 'application/json' } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { text += part; if (text.length > 65536) response.destroy(new Error('Oversized pairing response.')); });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200 && response.statusCode !== 201) { reject(new Error(`Pairing request failed: HTTP ${response.statusCode}`)); return; }
        try {
          const value: unknown = JSON.parse(text);
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid pairing response.');
          resolve(Object.fromEntries(Object.entries(value)));
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Pairing request timed out.')));
    req.on('error', reject);
    req.end(JSON.stringify(data));
  });
  const session = existingSession ? { sessionId: name } : await post('sessions', { name }, secret);
  if (typeof session.sessionId !== 'string') throw new Error('Missing session ID.');
  if (nativeOnly) {
    const pairing = await post('pairings', { sessionId: session.sessionId, role: 'native' }, secret);
    if (typeof pairing.code !== 'string') throw new Error('Missing pairing code.');
    process.stdout.write(JSON.stringify({ sessionId: session.sessionId, nativePairingCode: pairing.code, expiresInSeconds: 120 }, null, 2) + '\n');
    return;
  }
  if (!projectId || !outputFile) throw new Error('Missing DAW project or credential path');
  const codes: Record<string, string> = {};
  for (const role of ['native', 'executor', 'mcp']) {
    const pairing = await post('pairings', { sessionId: session.sessionId, role, projectId }, secret);
    if (typeof pairing.code !== 'string') throw new Error('Missing pairing code.');
    codes[role] = pairing.code;
  }
  const credential = await post('pairings/claim', { code: codes.mcp }, '');
  await mkdir(join(root, 'clients'), { recursive: true, mode: 0o700 });
  await writeFile(outputFile, JSON.stringify(credential), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ sessionId: session.sessionId, nativePairingCode: codes.native, executorPairingCode: codes.executor, credentialFile: outputFile, expiresInSeconds: 120 }, null, 2) + '\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Pairing failed.'}\n`);
  process.exitCode = 1;
});
