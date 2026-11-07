#!/usr/bin/env npx tsx
/**
 * daw-cli.ts — Lightweight DAW CLI for token-efficient Claude Code interaction.
 *
 * Usage: node server/daw-cli.ts <command> [args...]
 *
 * Connects to the DAW's WebSocket bridge, sends one command, prints compact
 * text output, and exits. Replaces the heavy MCP server pipeline.
 */
import { WebSocket } from 'ws';
import { parseCommand, formatResult } from './daw-cli-format';
import { prepareAudioImport } from './audio-import';

const BRIDGE_URL = process.env.DAW_MCP_BRIDGE_URL ?? 'ws://127.0.0.1:5174/ws/mcp-bridge';
const TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseCommand(args);

  if ('error' in parsed) {
    process.stderr.write(parsed.error + '\n');
    process.exit(1);
  }

  const { tool, params } = parsed;
  const id = `cli-${Date.now()}`;

  try {
    const result = await sendToolCall(id, tool, params);
    const output = formatResult(tool, result);
    process.stdout.write(output + '\n');
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function sendToolCall(
  id: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const requestParams = tool === 'daw_import_audio' ? await prepareAudioImport(params) : params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms — is the DAW dev server running?`));
    }, TIMEOUT_MS);

    const url = new URL(BRIDGE_URL);
    url.searchParams.set('role', 'agent');
    const ws = new WebSocket(url);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id, tool, params: requestParams }));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { id: string; result?: unknown; error?: string };
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) {
          reject(new Error(msg.error));
        } else {
          resolve(msg.result);
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${err.message}. Is the DAW running at ${BRIDGE_URL}?`));
    });

    ws.on('close', () => {
      clearTimeout(timer);
    });
  });
}

main();
