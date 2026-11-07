import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioImport } from '../../hooks/useAudioImport';
import { useProjectStore } from '../../store/projectStore';
import { importAudioFile } from '../audioImport';
import { loadAudioBlobByKey } from '../audioFileManager';
import { waveformMipmapService } from '../waveformMipmapService';

function createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
  const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length).fill(0.5));
  return {
    numberOfChannels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel) => channels[channel],
    copyFromChannel: (destination, channel, offset = 0) => destination.set(channels[channel].subarray(offset, offset + destination.length)),
    copyToChannel: (source, channel, offset = 0) => channels[channel].set(source, offset),
  };
}

const { decodeAudioData } = vi.hoisted(() => ({ decodeAudioData: vi.fn<() => Promise<AudioBuffer>>() }));
vi.mock('../../hooks/useAudioEngine', () => ({
  getAudioEngine: () => ({
    resume: async () => {},
    ctx: { decodeAudioData, createBuffer },
  }),
}));

function audioFile(): File {
  const file = new File(['audio'], 'guitar.take.wav', { type: 'audio/wav' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(8) });
  return file;
}

describe('audio import', () => {
  beforeEach(() => {
    vi.stubGlobal('Blob', NodeBlob);
    useProjectStore.setState({ project: null });
    useProjectStore.getState().createProject({ bpm: 120 });
    const project = useProjectStore.getState().project;
    if (!project) throw new Error('Project fixture was not created');
    useProjectStore.setState({ project: { ...project, totalDuration: 8 } });
    decodeAudioData.mockReset().mockResolvedValue(createBuffer(1, 320, 80));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves canonical reference bytes instead of re-encoding them', async () => {
    vi.stubGlobal('File', NodeFile);
    const file = new File([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], 'reference.wav', { type: 'audio/wav' });
    const imported = await importAudioFile(file, 0, { preserveSource: true });
    const persisted = await loadAudioBlobByKey(imported.audioKey);
    expect(persisted ? new Uint8Array(await persisted.arrayBuffer()) : null).toEqual(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));
  });

  it('rejects immutable references that would be silently trimmed', async () => {
    await expect(importAudioFile(audioFile(), 6, { preserveSource: true })).rejects.toThrow('does not fit');
    expect(useProjectStore.getState().project?.tracks).toEqual([]);
  });

  it('does not leave an empty track when GUI import starts at the project end', async () => {
    const { result } = renderHook(() => useAudioImport());
    const end = useProjectStore.getState().project?.totalDuration ?? 0;

    await act(async () => {
      await expect(result.current.importAudioFile(audioFile(), end)).rejects.toThrow(RangeError);
    });

    expect(useProjectStore.getState().project?.tracks).toEqual([]);
  });

  it('imports a ready sample clip and persists its trimmed WAV at the requested position', async () => {
    const result = await importAudioFile(audioFile(), 6);

    const tracks = useProjectStore.getState().project?.tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]).toMatchObject({ id: result.trackId, displayName: 'guitar.take', trackType: 'sample' });
    expect(tracks?.[0].clips).toHaveLength(1);
    expect(tracks?.[0].clips[0]).toMatchObject({
      id: result.clipId, startTime: 6, duration: 2, audioDuration: 2,
      generationStatus: 'ready', source: 'uploaded', audioOffset: 0,
      isolatedAudioKey: result.audioKey, prompt: 'Imported: guitar.take.wav',
      waveformPeaks: Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? 0.5 : 0),
    });
    expect(result.duration).toBe(2);
    const blob = await loadAudioBlobByKey(result.audioKey);
    expect(blob?.type).toBe('audio/wav');
    expect(blob?.size).toBe(44 + 160 * 2);
  });

  it('reuses the specified track without renaming it', async () => {
    const target = useProjectStore.getState().addTrack('custom', 'sample', { displayName: 'Existing' });

    const result = await importAudioFile(audioFile(), 1, target.id);

    const tracks = useProjectStore.getState().project?.tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]).toMatchObject({ id: target.id, displayName: 'Existing' });
    expect(tracks?.[0].clips).toMatchObject([{ id: result.clipId, startTime: 1, duration: 4, generationStatus: 'ready' }]);
    expect(result.trackId).toBe(target.id);
  });

  it.each([-1, NaN, Infinity, 8, 9])('rejects invalid start time %s without adding a track', async (startTime) => {
    await expect(importAudioFile(audioFile(), startTime)).rejects.toThrow(RangeError);

    expect(useProjectStore.getState().project?.tracks).toEqual([]);
  });

  it('rejects a missing target without adding a track', async () => {
    await expect(importAudioFile(audioFile(), 0, 'missing')).rejects.toThrow('Track not found');

    expect(useProjectStore.getState().project?.tracks).toEqual([]);
  });

  it('rejects missing project without creating one', async () => {
    useProjectStore.setState({ project: null });

    await expect(importAudioFile(audioFile())).rejects.toThrow('No project open');

    expect(useProjectStore.getState().project).toBeNull();
  });

  it('leaves no empty track when decoding fails', async () => {
    decodeAudioData.mockRejectedValueOnce(new DOMException('Unsupported audio', 'EncodingError'));

    await expect(importAudioFile(audioFile())).rejects.toThrow('Unsupported audio');

    expect(useProjectStore.getState().project?.tracks).toEqual([]);
  });

  it('rejects a project switch during decoding without mutating the replacement project', async () => {
    decodeAudioData.mockImplementationOnce(async () => {
      useProjectStore.getState().createProject({ name: 'Replacement' });
      return createBuffer(1, 320, 80);
    });

    await expect(importAudioFile(audioFile())).rejects.toThrow('Project changed');

    expect(useProjectStore.getState().project?.tracks).toEqual([]);
  });

  it('keeps imported clip creation undoable', async () => {
    const result = await importAudioFile(audioFile());

    useProjectStore.getState().undo();

    expect(useProjectStore.getState().project?.tracks.find((track) => track.id === result.trackId)?.clips).toEqual([]);
  });

  it('rejects a project switch during waveform computation and preserves the replacement project', async () => {
    vi.spyOn(waveformMipmapService, 'computeMipmap').mockImplementationOnce(async () => {
      await Promise.resolve();
      useProjectStore.getState().createProject({ name: 'Replacement' });
      return [];
    });

    await expect(importAudioFile(audioFile())).rejects.toThrow('Project changed');

    expect(useProjectStore.getState().project).toMatchObject({ name: 'Replacement', tracks: [] });
  });

  it('rejects a clip removed during waveform computation without restoring it', async () => {
    const track = useProjectStore.getState().addTrack('custom', 'sample');
    vi.spyOn(waveformMipmapService, 'computeMipmap').mockImplementationOnce(async () => {
      await Promise.resolve();
      const clip = useProjectStore.getState().project?.tracks.find((item) => item.id === track.id)?.clips[0];
      if (!clip) throw new Error('Imported clip was not created');
      useProjectStore.getState().removeClip(clip.id);
      return [];
    });

    await expect(importAudioFile(audioFile(), 0, track.id)).rejects.toThrow('Clip removed');

    expect(useProjectStore.getState().project?.tracks.find((item) => item.id === track.id)?.clips).toEqual([]);
  });
});
