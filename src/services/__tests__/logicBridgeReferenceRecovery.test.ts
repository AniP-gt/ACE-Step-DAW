import 'fake-indexeddb/auto';
import { File as NodeFile } from 'node:buffer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { attachLogicCapture } from '../logicBridge';
import * as audio from '../audioFileManager';
import * as waveform from '../../utils/waveformPeaks';
import * as storage from '../projectStorage';

const fixture = vi.hoisted(() => ({ bindings: [] as Record<string, unknown>[], failBinding: false, failReceipt: false, failJournalAt: 0, journalWrites: 0 }));
vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>();
  return { ...actual, set: async (key: IDBValidKey, value: unknown) => {
    if (typeof key === 'string' && key.startsWith('logic-bridge:attach:') && fixture.failReceipt) { fixture.failReceipt = false; throw new Error('receipt failed'); }
    if (typeof key === 'string' && key.startsWith('logic-bridge:attach-operation:') && ++fixture.journalWrites === fixture.failJournalAt) throw new Error('journal failed');
    return actual.set(key, value);
  } };
});
const buffer = { numberOfChannels: 1, length: 480, sampleRate: 480, duration: 1, getChannelData: () => new Float32Array(480) } as AudioBuffer;
vi.mock('../../hooks/useAudioEngine', () => ({ getAudioEngine: () => ({ ctx: { decodeAudioData: async () => buffer, createBuffer: () => buffer } }) }));
vi.mock('../logicBridgeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logicBridgeClient')>();
  return { ...actual, canonicalBlob: async () => new Blob(['audio']), bridgeJson: async (_token: string, path: string, body?: Record<string, unknown>) => {
    if (path.startsWith('/captures')) return { captures: [{ captureId: 'capture', state: 'ready', label: 'Reference', canonicalFrameCount: 48000, tempo: 120, timeSignature: [4, 4] }] };
    if (path.startsWith('/bindings?')) return { bindings: fixture.bindings };
    if (path === '/bindings' && body) { const binding = { ...body, bindingId: 'binding' }; fixture.bindings = [...fixture.bindings.filter(item => item.captureId !== body.captureId), binding]; if (fixture.failBinding) { fixture.failBinding = false; throw new Error('binding response lost'); } return binding; }
    throw new Error(`Unexpected path ${path}`);
  } };
});

describe('reference import recovery', () => {
  beforeEach(() => { vi.stubGlobal('File', NodeFile); fixture.bindings = []; fixture.failBinding = false; fixture.failReceipt = false; fixture.failJournalAt = 0; fixture.journalWrites = 0; useProjectStore.getState().createProject({ bpm: 120 }); const projectId = useProjectStore.getState().project!.id; useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId }); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const request = () => ({ sessionId: 'session', projectId: useProjectStore.getState().project!.id, captureId: 'capture', clientRequestId: 'request' });
  it.each([1, 2])('does not duplicate a reference after journal write %i fails with an existing binding', async (failedWrite) => {
    const req = request();
    const track = useProjectStore.getState().addTrack('custom', 'sample');
    const oldClip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: 'existing', lyrics: '' });
    fixture.bindings = [{ sessionId: 'session', projectId: req.projectId, captureId: 'old', clipId: oldClip.id, bindingId: 'old-binding' }];
    fixture.failJournalAt = failedWrite;
    await expect(attachLogicCapture(req)).rejects.toThrow('journal failed');
    if (failedWrite === 1) expect(useProjectStore.getState().project!.tracks.flatMap(item => item.clips)).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));
    vi.resetModules();
    const { useProjectStore: reloadedStore } = await import('../../store/projectStore');
    const { useLogicBridgeStore: reloadedBridge } = await import('../../store/logicBridgeStore');
    reloadedBridge.setState({ ...reloadedBridge.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId: req.projectId });
    const { attachLogicCapture: reloadedAttach } = await import('../logicBridge');
    if (failedWrite === 1) {
      await reloadedAttach(req);
      expect(fixture.bindings).toHaveLength(2);
    } else {
      await expect(reloadedAttach(req)).rejects.toThrow('Reference import');
      expect(fixture.bindings).toHaveLength(1);
      const partialTrack = reloadedStore.getState().project!.tracks.find(item => item.id !== track.id);
      expect(partialTrack).toBeDefined();
      reloadedStore.getState().removeTrack(partialTrack!.id);
      await reloadedAttach(req);
      expect(fixture.bindings).toHaveLength(2);
    }
    const clips = reloadedStore.getState().project!.tracks.flatMap(item => item.clips);
    expect(clips).toHaveLength(2);
    expect(clips.find(item => item.id === oldClip.id)?.prompt).toBe('existing');
  });
  it.each(['save', 'waveform', 'receipt', 'binding'])('retries a %s failure without duplicating the reference', async (failure) => {
    if (failure === 'save') vi.spyOn(audio, 'saveAudioBlob').mockRejectedValueOnce(new Error('save failed'));
    if (failure === 'waveform') vi.spyOn(waveform, 'computeWaveformWithMipmap').mockRejectedValueOnce(new Error('waveform failed'));
    if (failure === 'receipt') fixture.failReceipt = true;
    if (failure === 'binding') fixture.failBinding = true;
    await expect(attachLogicCapture(request())).rejects.toThrow();
    await attachLogicCapture(request());
    expect(useProjectStore.getState().project!.tracks.flatMap(track => track.clips)).toHaveLength(1);
    expect(fixture.bindings).toHaveLength(1);
  });
  it('does not delete an edited incomplete clip or unrelated user clip', async () => {
    vi.spyOn(audio, 'saveAudioBlob').mockImplementationOnce(async () => {
      const own = useProjectStore.getState().project!.tracks[0].clips[0];
      useProjectStore.getState().updateClip(own.id, { prompt: 'edited' });
      const extra = useProjectStore.getState().addTrack('custom', 'sample');
      useProjectStore.getState().addClip(extra.id, { startTime: 0, duration: 1, prompt: 'user', lyrics: '' });
      throw new Error('save failed');
    });
    await expect(attachLogicCapture(request())).rejects.toThrow();
    await expect(attachLogicCapture(request())).rejects.toThrow();
    expect(useProjectStore.getState().project!.tracks.flatMap(track => track.clips).map(clip => clip.prompt)).toEqual(['edited', 'user']);
  });
  it('does not create a binding when project persistence fails', async () => {
    vi.spyOn(storage, 'saveProject').mockRejectedValueOnce(new Error('project save failed'));
    await expect(attachLogicCapture(request())).rejects.toThrow('project save failed');
    expect(fixture.bindings).toHaveLength(0);
    await attachLogicCapture(request());
    expect(fixture.bindings).toHaveLength(1);
    expect(useProjectStore.getState().project!.tracks.flatMap(track => track.clips)).toHaveLength(1);
  });
  it.each(['save', 'receipt'])('recovers %s failure after a page reload', async (failure) => {
    if (failure === 'save') vi.spyOn(audio, 'saveAudioBlob').mockRejectedValueOnce(new Error('save failed'));
    else fixture.failReceipt = true;
    const req = request();
    await expect(attachLogicCapture(req)).rejects.toThrow();
    window.dispatchEvent(new Event('pagehide'));
    vi.restoreAllMocks();
    vi.resetModules();
    const { useProjectStore: reloadedStore } = await import('../../store/projectStore');
    const { useLogicBridgeStore: reloadedBridge } = await import('../../store/logicBridgeStore');
    reloadedBridge.setState({ ...reloadedBridge.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId: req.projectId });
    const { attachLogicCapture: reloadedAttach } = await import('../logicBridge');
    await reloadedAttach(req);
    expect(reloadedStore.getState().project!.tracks.flatMap(track => track.clips)).toHaveLength(1);
    expect(fixture.bindings).toHaveLength(1);
  });
  it('preserves a changed incomplete reference after a page reload', async () => {
    vi.spyOn(audio, 'saveAudioBlob').mockRejectedValueOnce(new Error('save failed'));
    const req = request();
    await expect(attachLogicCapture(req)).rejects.toThrow();
    const clip = useProjectStore.getState().project!.tracks[0].clips[0];
    useProjectStore.getState().updateClip(clip.id, { prompt: 'user edit' });
    window.dispatchEvent(new Event('pagehide'));
    vi.restoreAllMocks();
    vi.resetModules();
    const { useProjectStore: reloadedStore } = await import('../../store/projectStore');
    const { useLogicBridgeStore: reloadedBridge } = await import('../../store/logicBridgeStore');
    reloadedBridge.setState({ ...reloadedBridge.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId: req.projectId });
    const { attachLogicCapture: reloadedAttach } = await import('../logicBridge');
    await expect(reloadedAttach(req)).rejects.toThrow('Reference import was changed');
    expect(reloadedStore.getState().getClipById(clip.id)?.prompt).toBe('user edit');
    expect(fixture.bindings).toHaveLength(0);
  });
});
