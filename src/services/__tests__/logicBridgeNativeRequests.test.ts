import { describe, expect, it } from 'vitest';
import { nativeReferenceValid } from '../logicBridgeNativeRequests';

describe('native reference validation', () => {
  it('requires the same binding, capture, full range, and ready source clip', () => {
    const receipt = { bindingId: 'binding', captureId: 'capture', projectId: 'project' };
    const binding = { bindingId: 'binding', captureId: 'capture', projectId: 'project', clipId: 'clip', canonicalSha256: 'hash' };
    const capture = { captureId: 'capture', state: 'ready', canonicalSha256: 'hash', canonicalFrameCount: 48000 };
    const clip = { id: 'clip', startTime: 0, duration: 1, isolatedAudioKey: 'audio', generationStatus: 'ready', source: 'uploaded' };
    expect(nativeReferenceValid(receipt, binding, capture, clip)).toBe(true);
    expect(nativeReferenceValid(receipt, binding, capture, { ...clip, duration: 0.5 })).toBe(false);
    expect(nativeReferenceValid(receipt, binding, capture, undefined)).toBe(false);
    expect(nativeReferenceValid(receipt, binding, capture, { ...clip, audioOffset: 0.1 })).toBe(false);
    expect(nativeReferenceValid(receipt, binding, capture, { ...clip, timeStretchRate: 2 })).toBe(false);
    expect(nativeReferenceValid(receipt, { ...binding, canonicalSha256: 'other' }, capture, clip)).toBe(false);
  });
});

import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { set } from 'idb-keyval';
import { beforeEach, vi } from 'vitest';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { useModelStore } from '../../store/modelStore';
import { useGenerationStore } from '../../store/generationStore';
import { processNativeRequests } from '../logicBridgeNativeRequests';
import { attachLogicCapture } from '../logicBridge';
const io = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], calls: [] as string[] }));
vi.mock('../logicBridgeClient', async original => {
  const actual = await original<typeof import('../logicBridgeClient')>();
  return { ...actual, bridgeJson: async (_token: string, path: string) => { io.calls.push(path); return path.startsWith('/executor/native-requests') ? { requests: io.requests } : {}; } };
});
vi.mock('../logicBridge', () => ({ attachLogicCapture: vi.fn(), refreshBridge: async () => {} }));

describe('native request polling against the project store', () => {
  beforeEach(() => { io.requests = []; io.calls = []; useProjectStore.getState().createProject({ bpm: 120 }); useGenerationStore.setState(useGenerationStore.getInitialState(), true); });
  it('invalidates a deleted prepared clip and never submits its pending intent', async () => {
    const projectId = useProjectStore.getState().project!.id;
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId, executorId: 'executor' });
    const request = { requestId: 'prepare', kind: 'prepare', state: 'prepared', sessionId: 'session', projectId, bindingId: 'binding', captureId: 'capture' };
    io.requests = [request];
    await processNativeRequests({ token: 'token', sessionId: 'session', projectId, guard: () => {} });
    expect(io.calls).toContain('/native-requests/prepare/invalidate');
    expect(io.calls.some(path => path.endsWith('/submit'))).toBe(false);
  });
  it('fails generation when the verified model unloads before acknowledgement', async () => {
    const projectId = useProjectStore.getState().project!.id;
    const track = useProjectStore.getState().addTrack('custom', 'sample');
    const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
    await set('fixture-audio', new NodeBlob(['audio']));
    useProjectStore.getState().updateClipStatus(clip.id, 'ready', { isolatedAudioKey: 'fixture-audio', source: 'uploaded' });
    const hash = '6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b';
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId, executorId: 'executor', verifiedModelId: 'base', bindings: [{ bindingId: 'binding', projectId, captureId: 'capture', clipId: clip.id, canonicalSha256: hash }], captures: [{ captureId: 'capture', state: 'ready', canonicalFrameCount: 48000, canonicalSha256: hash }] });
    useModelStore.setState({ availableModels: [] });
    io.requests = [{ requestId: 'intent', kind: 'generation', state: 'pending', sessionId: 'session', projectId, bindingId: 'binding', captureId: 'capture', instrument: 'piano' }];
    await processNativeRequests({ token: 'token', sessionId: 'session', projectId, guard: () => {} });
    expect(io.calls).toContain('/native-requests/intent/fail');
    expect(io.calls.some(path => path.endsWith('/submit'))).toBe(false);
  });
  it('does not acknowledge an existing binding when its clip is stale', async () => {
    const projectId = useProjectStore.getState().project!.id;
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), connected: true, token: 'token', sessionId: 'session', projectId, executorId: 'executor', bindings: [{ bindingId: 'binding', projectId, captureId: 'capture', clipId: 'removed', canonicalSha256: 'hash' }], captures: [{ captureId: 'capture', state: 'ready', canonicalFrameCount: 48000, canonicalSha256: 'hash' }] });
    vi.mocked(attachLogicCapture).mockResolvedValueOnce({ bindingId: 'binding' });
    io.requests = [{ requestId: 'prepare', kind: 'prepare', state: 'pending', sessionId: 'session', projectId, captureId: 'capture' }];
    await processNativeRequests({ token: 'token', sessionId: 'session', projectId, guard: () => {} });
    expect(io.calls).toContain('/native-requests/prepare/fail');
    expect(io.calls).not.toContain('/native-requests/prepare/prepared');
  });

});
