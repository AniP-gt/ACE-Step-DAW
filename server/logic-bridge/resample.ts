import { createRequire } from 'node:module';
import { check } from './validation';
const LibSampleRate: typeof import('@alexanderolsen/libsamplerate-js') = createRequire(import.meta.url)('@alexanderolsen/libsamplerate-js');

export async function stereoPcm(pcm: Buffer, rate: number, channels: number): Promise<Buffer> {
  const sourceFrames = pcm.length / (channels * 4);
  const frames = Math.round(sourceFrames * 48000 / rate);
  const output = Buffer.alloc(frames * 8);
  if (rate === 48000) {
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) {
      output.writeFloatLE(pcm.readFloatLE((frame * channels + Math.min(channel, channels - 1)) * 4), frame * 8 + channel * 4);
    }
    return output;
  }
  const converter = await LibSampleRate.create(channels, rate, 48000, { converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY });
  const padding = rate / 10;
  try {
    // Bounded one-shot calls avoid the library's large-input streaming path,
    // which does not flush its tail. Real overlap preserves filter continuity.
    for (let start = 0; start < sourceFrames; start += rate) {
      const input = new Float32Array((rate + padding * 2) * channels);
      for (let frame = 0; frame < rate + padding * 2; frame++) {
        const source = start - padding + frame;
        if (source >= 0 && source < sourceFrames) for (let channel = 0; channel < channels; channel++) {
          input[frame * channels + channel] = pcm.readFloatLE((source * channels + channel) * 4);
        }
      }
      const converted = converter.simple(input);
      const destination = start / rate * 48000;
      const count = Math.min(48000, frames - destination);
      check(converted.length >= (4800 + count) * channels, 'INVALID_AUDIO', 'Resampler did not produce the complete reference range');
      for (let frame = 0; frame < count; frame++) for (let channel = 0; channel < 2; channel++) {
        const value = converted[(4800 + frame) * channels + Math.min(channel, channels - 1)];
        check(Number.isFinite(value), 'INVALID_AUDIO', 'Non-finite resampler output');
        output.writeFloatLE(value, (destination + frame) * 8 + channel * 4);
      }
    }
    return output;
  } finally {
    converter.destroy();
  }
}
