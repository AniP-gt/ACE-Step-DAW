import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { claudeTerminalPlugin } from '../../server/vite-plugin-claude-terminal';

const children: ChildProcess[] = [];
const servers: ViteDevServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  children.forEach(child => child.kill());
  sockets.forEach(socket => socket.terminate());
  await Promise.all(servers.map(server => server.close()));
});

describe('Codex DAW MCP connection', () => {
  it.each([0, 2])('rejects tool calls when %i browser tabs are connected', async (count) => {
    const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [claudeTerminalPlugin()], server: { host: '127.0.0.1', port: 0 } });
    servers.push(server);
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `ws://127.0.0.1:${address.port}/ws/mcp-bridge`;
    for (let index = 0; index < count; index++) {
      const browser = new WebSocket(url);
      sockets.push(browser);
      await once(browser, 'open');
    }
    const agent = new WebSocket(`${url}?role=agent`);
    sockets.push(agent);
    await once(agent, 'open');
    const received = once(agent, 'message');
    agent.send(JSON.stringify({ id: 'ambiguous', tool: 'daw_set_bpm', params: { bpm: 90 } }));
    const [response] = await received;
    expect(JSON.parse(String(response))).toEqual({ id: 'ambiguous', error: count === 0
      ? 'Open the DAW in a browser before using DAW tools.'
      : 'Multiple DAW tabs are open. Close the other tabs before using DAW tools.' });
  });

  it('answers newline-delimited initialization and tool discovery', async () => {
    const bridge = new WebSocketServer({ port: 0 });
    await once(bridge, 'listening');
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/mcp-server.ts'], {
      env: { ...process.env, DAW_MCP_BRIDGE_URL: `ws://127.0.0.1:${address.port}/ws/mcp-bridge` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    bridge.on('connection', socket => sockets.push(socket));
    try {
      const responses: Record<string, unknown>[] = [];
      let output = '';
      child.stdout?.on('data', chunk => {
        output += String(chunk);
        const lines = output.split('\n');
        output = lines.pop() ?? '';
        for (const line of lines) responses.push(JSON.parse(line));
      });
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Codex test', version: '1' } } }) + '\n');
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      await expect.poll(() => responses.map(response => response.id), { timeout: 2500 }).toEqual([1, 2]);
      expect(responses[1]).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'daw_get_project' })]) } });
    } finally {
      child.kill();
      for (const socket of bridge.clients) socket.terminate();
      await new Promise<void>(resolve => bridge.close(() => resolve()));
    }
  });

  it('relays agent tool calls to the browser and returns its response', async () => {
    const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [claudeTerminalPlugin()], server: { host: '127.0.0.1', port: 0 } });
    servers.push(server);
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const url = `ws://127.0.0.1:${address.port}/ws/mcp-bridge`;
    const browser = new WebSocket(url);
    const agent = new WebSocket(`${url}?role=agent`);
    sockets.push(browser, agent);
    await Promise.all([once(browser, 'open'), once(agent, 'open')]);
    const request = JSON.stringify({ id: 'codex-call', tool: 'daw_get_project', params: {} });
    const received = once(browser, 'message');
    agent.send(request);
    const [data] = await received;
    expect(String(data)).toBe(request);
    const returned = once(agent, 'message');
    browser.send(JSON.stringify({ id: 'codex-call', result: { name: 'My DAW project' } }));
    const [response] = await returned;
    expect(JSON.parse(String(response))).toEqual({ id: 'codex-call', result: { name: 'My DAW project' } });
  }, 4000);
});
