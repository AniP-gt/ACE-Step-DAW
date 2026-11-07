import { expect, it } from 'vitest';
import LibSampleRate from '@alexanderolsen/libsamplerate-js';
import { stereoPcm } from '../../server/logic-bridge/resample';

function signal(frames: number, sample: (frame: number) => number): Buffer {
  const pcm = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) pcm.writeFloatLE(sample(frame), frame * 4);
  return pcm;
}

it.each([44100, 88200, 96000])('preserves 1kHz passband gain and phase across chunk joins from %i Hz', async rate => {
  const output = await stereoPcm(signal(rate * 3, frame => 0.5 * Math.sin(2 * Math.PI * 1000 * frame / rate)), rate, 1);
  let squaredError = 0; let squaredSignal = 0;
  const count = 144000 - 1920;
  for (let frame = 960; frame < 144000 - 960; frame++) {
    const value = output.readFloatLE(frame * 8);
    squaredError += (value - 0.5 * Math.sin(2 * Math.PI * 1000 * frame / 48000)) ** 2;
    squaredSignal += value ** 2;
    expect(output.readFloatLE(frame * 8 + 4)).toBe(value);
  }
  expect(Math.sqrt(squaredError / count)).toBeLessThan(0.0001);
  expect(Math.sqrt(squaredSignal / count)).toBeCloseTo(Math.SQRT1_2 * 0.5, 4);
});

it('suppresses a 30kHz source tone instead of aliasing it into 48kHz output', async () => {
  const output = await stereoPcm(signal(96000 * 2, frame => 0.5 * Math.sin(2 * Math.PI * 30000 * frame / 96000)), 96000, 1);
  let energy = 0;
  for (let frame = 960; frame < 96000 - 960; frame++) energy += output.readFloatLE(frame * 8) ** 2;
  expect(Math.sqrt(energy / (96000 - 1920))).toBeLessThan(0.001);
});

it.each([44100, 88200, 96000].flatMap(rate => [0, rate - 1, rate, rate + 1, rate * 2 - 1].map(position => ({ rate, position }))))('keeps impulse position $position at $rate Hz including file and chunk edges', async ({ rate, position }) => {
  const output = await stereoPcm(signal(rate * 2, frame => frame === position ? 0.75 : 0), rate, 1);
  expect(output.length).toBe(96000 * 8);
  let peak = 0; let peakFrame = -1;
  for (let frame = 0; frame < 96000; frame++) {
    const value = Math.abs(output.readFloatLE(frame * 8));
    if (value > peak) { peak = value; peakFrame = frame; }
  }
  expect(peak).toBeGreaterThan(0);
  expect(Math.abs(peakFrame - Math.min(95999, Math.round(position * 48000 / rate)))).toBeLessThanOrEqual(1);
});

it.each([{ rate: 44100, frames: 44105, expected: 48005 }, { rate: 44100, frames: 44106, expected: 48007 }, { rate: 96000, frames: 96001, expected: 48001 }])('returns exactly $expected frames for $frames frames at $rate Hz', async ({ rate, frames, expected }) => {
  const output = await stereoPcm(signal(frames, frame => frame === frames - 1 ? 0.5 : 0), rate, 1);
  expect(output.length).toBe(expected * 8);
  const lastSamples = [expected - 2, expected - 1].map(frame => Math.abs(output.readFloatLE(frame * 8)));
  expect(Math.max(...lastSamples)).toBeGreaterThan(0);
});

it('preserves both channel tails of a six-second stereo source beyond the library streaming threshold', async () => {
  const input = Buffer.alloc(96000 * 6 * 2 * 4);
  for (let frame = 0; frame < 96000 * 6; frame++) {
    const value = 0.5 * Math.sin(2 * Math.PI * 1000 * frame / 96000);
    input.writeFloatLE(value, frame * 8);
    input.writeFloatLE(-value, frame * 8 + 4);
  }
  const output = await stereoPcm(input, 96000, 2);
  expect(output.length).toBe(288000 * 8);
  for (const channel of [0, 1]) {
    let error = 0;
    for (let frame = 252000; frame < 287040; frame++) error += (output.readFloatLE(frame * 8 + channel * 4) - (channel === 0 ? 1 : -1) * 0.5 * Math.sin(2 * Math.PI * 1000 * frame / 48000)) ** 2;
    expect(Math.sqrt(error / (287040 - 252000))).toBeLessThan(0.0001);
  }
});

it('matches a bounded independent one-shot conversion across both chunk boundaries', async () => {
  const rate = 88200;
  const frames = rate * 3;
  const input = Float32Array.from({ length: frames }, (_, frame) => 0.4 * Math.sin(2 * Math.PI * 1733 * frame / rate) + (frame === rate - 1 || frame === rate * 2 + 1 ? 0.5 : 0));
  const converter = await LibSampleRate.create(1, rate, 48000, { converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY });
  try {
    const reference = converter.simple(input);
    const output = await stereoPcm(Buffer.from(input.buffer), rate, 1);
    expect(reference.length).toBe(144000);
    for (const boundary of [48000, 96000]) {
      let largestError = 0;
      for (let frame = boundary - 128; frame <= boundary + 128; frame++) largestError = Math.max(largestError, Math.abs(output.readFloatLE(frame * 8) - reference[frame]));
      expect(largestError).toBeLessThan(0.00001);
    }
  } finally { converter.destroy(); }
});

it.each([1, 2])('keeps all 48kHz input samples bit-exact for %i channels', async channels => {
  const pcm = Buffer.alloc(4000 * channels * 4);
  for (let frame = 0; frame < 4000; frame++) for (let channel = 0; channel < channels; channel++) pcm.writeFloatLE((channel === 0 ? 1 : -1) * Math.sin(frame * 0.17) * 0.75, (frame * channels + channel) * 4);
  const output = await stereoPcm(pcm, 48000, channels);
  for (let frame = 0; frame < 4000; frame++) for (let channel = 0; channel < 2; channel++) expect(output.readUInt32LE(frame * 8 + channel * 4)).toBe(pcm.readUInt32LE((frame * channels + Math.min(channel, channels - 1)) * 4));
});
