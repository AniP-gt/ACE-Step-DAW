import { createHash } from 'node:crypto';
import { check } from './validation';
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
export function canonicalize(pcm: Buffer, rate: number, channels: number): Buffer {
  const sourceFrames = pcm.length / (channels * 4);
  const frames = Math.round(sourceFrames * 48000 / rate);
  const output = Buffer.alloc(frames * 8);
  let audible = false;
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const value = pcm.readFloatLE(offset);
    check(Number.isFinite(value), 'INVALID_AUDIO', 'Non-finite samples');
    audible ||= value !== 0;
  }
  check(audible, 'SILENT_AUDIO', 'Reference is entirely silent');
  for (let frame = 0; frame < frames; frame++) {
    const position = frame * rate / 48000;
    const left = Math.min(Math.floor(position), sourceFrames - 1);
    const right = Math.min(left + 1, sourceFrames - 1);
    for (let channel = 0; channel < 2; channel++) {
      const index = Math.min(channel, channels - 1);
      const a = pcm.readFloatLE((left * channels + index) * 4);
      const b = pcm.readFloatLE((right * channels + index) * 4);
      output.writeFloatLE(a + (b - a) * (position - left), frame * 8 + channel * 4);
    }
  }
  return wav(output, 48000, 2);
}
export function validateResult(bytes: Buffer, frames: number): void {
  check(bytes.length === frames * 8 + 44 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 16) === 'WAVEfmt ' && bytes.readUInt32LE(16) === 16
    && bytes.readUInt16LE(20) === 3 && bytes.readUInt16LE(22) === 2
    && bytes.readUInt32LE(24) === 48000 && bytes.readUInt16LE(34) === 32
    && bytes.toString('ascii', 36, 40) === 'data' && bytes.readUInt32LE(40) === frames * 8,
  'INVALID_RESULT', 'Expected exact-range canonical float32 stereo WAV');
  for (let offset = 44; offset < bytes.length; offset += 4) check(Number.isFinite(bytes.readFloatLE(offset)), 'INVALID_RESULT', 'Non-finite output');
}
