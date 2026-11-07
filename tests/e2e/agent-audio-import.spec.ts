import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadFreshApp, createProjectViaDialog } from '../support/e2eStartup';
import { getProjectState } from '../support/browserStores';

test('imports an agent-created WAV into a ready timeline clip', async ({ page }) => {
  await loadFreshApp(page);
  await createProjectViaDialog(page, 'Agent Audio Import', 120);
  const directory = await mkdtemp(join(tmpdir(), 'daw-import-e2e-'));
  const path = join(directory, 'Agent strings.wav');
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(16000, 40);
  for (let frame = 0; frame < 8000; frame++) {
    bytes.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 440 / 8000) * 4000), 44 + frame * 2);
  }
  await writeFile(path, bytes);
  try {
    await expect(page.getByTestId('dock-ai-assistant-toggle')).toBeVisible();
    const bridgeUrl = `ws://${new URL(page.url()).host}/ws/mcp-bridge`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/daw-cli.ts', 'import-audio', path], {
      env: { ...process.env, DAW_MCP_BRIDGE_URL: bridgeUrl },
      timeout: 20000,
    });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ duration: 1, trackId: expect.any(String), clipId: expect.any(String), audioKey: expect.any(String) });
    const project = (await getProjectState(page)).project;
    const track = project?.tracks.find(track => track.id === result.trackId);
    expect(track?.clips.find(clip => clip.id === result.clipId)).toMatchObject({
      generationStatus: 'ready', isolatedAudioKey: result.audioKey, audioDuration: 1,
    });
    await expect(page.getByText('Imported: Agent strings.wav', { exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/ace-agent-audio-import.png' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
