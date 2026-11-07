import { createHash } from 'node:crypto';
import { check } from './validation';
import { stereoPcm } from './resample';
export const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export function wav(pcm: Buffer, rate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export async function canonicalize(pcm: Buffer, rate: number, channels: number): Promise<Buffer> {
  let audible = false;
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const value = pcm.readFloatLE(offset);
    check(Number.isFinite(value), 'INVALID_AUDIO', 'Non-finite samples');
    audible ||= value !== 0;
  }
  check(audible, 'SILENT_AUDIO', 'Reference is entirely silent');
  return wav(await stereoPcm(pcm, rate, channels), 48000, 2);
}
export function validateResult(bytes: Buffer, frames: number): void {
  check(bytes.length === frames * 8 + 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.toString('ascii', 8, 16) === 'WAVEfmt ' && bytes.readUInt32LE(16) === 16
    && bytes.readUInt16LE(20) === 3 && bytes.readUInt16LE(22) === 2
    && bytes.readUInt32LE(24) === 48000 && bytes.readUInt32LE(28) === 48000 * 8 && bytes.readUInt16LE(32) === 8 && bytes.readUInt16LE(34) === 32
    && bytes.toString('ascii', 36, 40) === 'data' && bytes.readUInt32LE(40) === frames * 8,
  'INVALID_RESULT', 'Expected exact-range canonical float32 stereo WAV');
  for (let offset = 44; offset < bytes.length; offset += 4) check(Number.isFinite(bytes.readFloatLE(offset)), 'INVALID_RESULT', 'Non-finite output');
}
