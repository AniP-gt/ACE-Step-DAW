import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { useGenerationStore } from '../../store/generationStore';
import { attachLogicCapture, addLayerFromLogicContext, boundConnection, disconnectBridge } from '../logicBridge';

vi.mock('../projectStorage', () => ({ saveProject: vi.fn() }));
vi.mock('../audioImport', () => ({ importAudioFile: vi.fn() }));
vi.mock('../generationPipeline', () => ({ generateFromExplicitContext: vi.fn() }));

describe('Logic bridge project boundaries', () => {
  beforeEach(() => {
    useProjectStore.getState().createProject();
    useGenerationStore.setState({ isGenerating: false });
    useLogicBridgeStore.setState({ ...useLogicBridgeStore.getInitialState(), token: 'fixture', sessionId: 'session', projectId: useProjectStore.getState().project?.id, connected: true });
  });
  afterEach(() => { disconnectBridge(); vi.unstubAllGlobals(); });

  it('rejects a different session and a switched project', () => {
    const id = useProjectStore.getState().project?.id ?? '';
    expect(() => boundConnection('other-session', id)).toThrow('STALE_BINDING');
    useProjectStore.getState().createProject();
    expect(() => boundConnection('session', id)).toThrow('STALE_BINDING');
  });

  it('does not reattach a deleted reference from durable binding history', async () => {
    const projectId = useProjectStore.getState().project?.id ?? '';
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.includes('/captures') ? { captures: [] } : { bindings: [{ bindingId: 'binding', captureId: 'capture', projectId, clipId: 'deleted' }] }), { status: 200 }));
    await expect(attachLogicCapture({ sessionId: 'session', projectId, captureId: 'capture', clientRequestId: 'request' })).rejects.toThrow('STALE_BINDING');
    expect(useProjectStore.getState().project?.tracks.flatMap(track => track.clips)).toEqual([]);
  });

  it('rejects a busy project without creating a pending clip or submitting a job', async () => {
    const request = { sessionId: 'session', projectId: useProjectStore.getState().project?.id };
    useGenerationStore.setState({ isGenerating: true });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(addLayerFromLogicContext(request)).rejects.toThrow('PROJECT_BUSY');
    expect(fetch).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project?.tracks.flatMap(track => track.clips)).toEqual([]);
  });
});
