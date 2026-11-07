import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAudioImport } from '../../server/audio-import';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('local audio import transport', () => {
  it('transfers the exact audio bytes and filename without splitting paths with spaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daw-audio-'));
    directories.push(directory);
    const path = join(directory, 'strings phrase.wav');
    await writeFile(path, Buffer.from([82, 73, 70, 70, 0, 255, 128, 1]));
    const prepared = await prepareAudioImport({ path, trackId: 'track-1', startTime: 4 });
    expect(Buffer.from(prepared.audioBase64, 'base64')).toEqual(await readFile(path));
    expect(prepared).toMatchObject({ fileName: 'strings phrase.wav', trackId: 'track-1', startTime: 4 });
  });

  it.each([{}, { path: '/tmp/private.txt' }])('rejects invalid or non-audio file requests', async params => {
    await expect(prepareAudioImport(params)).rejects.toThrow('audio');
  });
});
