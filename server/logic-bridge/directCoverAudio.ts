import { canonicalize } from './audio';
import { check } from './validation';

/** Decode a bounded WAV returned by ACE-Step before producing the bridge's canonical float WAV. */
export async function canonicalCover(bytes: Buffer): Promise<Buffer> {
  check(bytes.length >= 44 && bytes.length <= 64 * 1024 * 1024 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) + 8 === bytes.length, 'INVALID_RESULT', 'Expected bounded WAV result');
  let format = 0, channels = 0, rate = 0, bits = 0, blockAlign = 0; let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4); const begin = offset + 8; const end = begin + size;
    check(end <= bytes.length, 'INVALID_RESULT', 'Truncated WAV chunk');
    const id = bytes.toString('ascii', offset, offset + 4);
    if (id === 'fmt ') {
      check(size >= 16, 'INVALID_RESULT', 'Invalid WAV format');
      format = bytes.readUInt16LE(begin); channels = bytes.readUInt16LE(begin + 2); rate = bytes.readUInt32LE(begin + 4); blockAlign = bytes.readUInt16LE(begin + 12); bits = bytes.readUInt16LE(begin + 14);
      if (format === 0xfffe) { check(size >= 40, 'INVALID_RESULT', 'Invalid extensible WAV'); format = bytes.readUInt16LE(begin + 24); }
    } else if (id === 'data') { check(!pcm, 'INVALID_RESULT', 'Multiple WAV data chunks'); pcm = bytes.subarray(begin, end); }
    offset = end + (size % 2);
  }
  check(pcm && (channels === 1 || channels === 2) && [44100, 48000, 88200, 96000].includes(rate) && ((format === 3 && bits === 32) || (format === 1 && [16, 24, 32].includes(bits))) && blockAlign === channels * bits / 8 && pcm.length > 0 && pcm.length % blockAlign === 0, 'INVALID_RESULT', 'Unsupported WAV audio format');
  const frames = pcm.length / blockAlign;
  check(frames / rate <= 120 && Math.round(frames * 48000 / rate) * 8 + 44 <= 64 * 1024 * 1024, 'INVALID_RESULT', 'Result duration or size exceeds limit');
  const floats = Buffer.alloc(frames * channels * 4);
  for (let i = 0; i < frames * channels; i++) {
    const pos = i * bits / 8;
    const value = format === 3 ? pcm.readFloatLE(pos) : bits === 16 ? pcm.readInt16LE(pos) / 32768 : bits === 24 ? pcm.readIntLE(pos, 3) / 8388608 : pcm.readInt32LE(pos) / 2147483648;
    check(Number.isFinite(value), 'INVALID_RESULT', 'Non-finite output sample'); floats.writeFloatLE(value, i * 4);
  }
  return canonicalize(floats, rate, channels);
}
