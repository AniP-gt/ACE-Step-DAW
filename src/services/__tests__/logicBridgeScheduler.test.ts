import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { useModelStore } from '../../store/modelStore';
import { useGenerationStore } from '../../store/generationStore';
import { connectBridge, disconnectBridge } from '../logicBridge';
import { runBridgeJob } from '../logicBridgeExecutor';
import { processNativeRequests } from '../logicBridgeNativeRequests';

const io = vi.hoisted(() => ({ paths: [] as string[], projectId: '', jobError: false }));
vi.mock('../logicBridgeClient', async original => {
  const actual = await original<typeof import('../logicBridgeClient')>();
  return { ...actual, bridgeJson: async (_token: string, path: string) => {
    io.paths.push(path);
    if (path === '/pairings/claim') return { role: 'executor', token: 'token', sessionId: 'session', projectId: io.projectId };
    if (path === '/executor/register') return {};
    if (path.startsWith('/captures?')) return { captures: [] };
    if (path.startsWith('/bindings?')) return { bindings: [] };
    if (path.startsWith('/executor/jobs?')) { if (io.jobError) throw new Error('jobs forbidden'); return { jobs: [{ jobId: 'job', state: 'queued' }] }; }
    throw new Error(`Unexpected ${path}`);
  } };
});
vi.mock('../logicBridgeExecutor', () => ({ runBridgeJob: vi.fn(async () => {}) }));
vi.mock('../logicBridgeNativeRequests', () => ({ processNativeRequests: vi.fn() }));
vi.mock('../logicBridgeReconciliation', () => ({ reconcileBridgeJob: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); useProjectStore.getState().createProject(); io.projectId = useProjectStore.getState().project!.id; io.paths = []; io.jobError = false;
  useLogicBridgeStore.setState(useLogicBridgeStore.getInitialState(), true);
  useGenerationStore.setState({ isGenerating: false, backendOccupancyJobId: null }); useModelStore.setState({ availableModels: [] });
  vi.mocked(runBridgeJob).mockClear(); vi.mocked(processNativeRequests).mockReset();
});
afterEach(() => { disconnectBridge(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([['error', new Error('native offline'), 'native offline'], ['undefined', undefined, 'Bridge connection failed']] as const)('executes queued jobs and preserves native %s', async (_name, error, message) => {
  vi.mocked(processNativeRequests).mockImplementation(async () => { throw error; });
  await connectBridge('code');
  await vi.waitFor(() => expect(useLogicBridgeStore.getState().error).toBe(message));
  expect(io.paths.some(path => path.startsWith('/executor/jobs?'))).toBe(true);
  expect(runBridgeJob).toHaveBeenCalledTimes(1);
});

it('does not dispatch after jobs authorization fails and reports the jobs error', async () => {
  vi.mocked(processNativeRequests).mockRejectedValue(new Error('native offline')); io.jobError = true;
  await connectBridge('code');
  await vi.waitFor(() => expect(useLogicBridgeStore.getState().error).toBe('jobs forbidden'));
  expect(io.paths.some(path => path.startsWith('/executor/jobs?'))).toBe(true);
  expect(runBridgeJob).not.toHaveBeenCalled();
});

it.each(['project', 'token', 'session', 'executor', 'epoch'] as const)('does not fetch jobs or mutate error after %s changes during native processing', async field => {
  const abort = vi.spyOn(AbortController.prototype, 'abort');
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { reached = resolve; });
  vi.mocked(processNativeRequests).mockImplementation(async () => { reached(); await gate; throw new Error('old failure'); });
  await connectBridge('code'); await entered;
  useLogicBridgeStore.setState({ error: 'sentinel' });
  if (field === 'project') useProjectStore.getState().createProject();
  if (field === 'token') useLogicBridgeStore.setState({ token: 'new-token' });
  if (field === 'session') useLogicBridgeStore.setState({ sessionId: 'new-session' });
  if (field === 'executor') useLogicBridgeStore.setState({ executorId: 'new-executor' });
  if (field === 'epoch') {
    disconnectBridge();
    expect(abort.mock.contexts.some(controller => controller.signal.aborted)).toBe(true);
  }
  const before = useLogicBridgeStore.getState(); release();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(io.paths.some(path => path.startsWith('/executor/jobs?'))).toBe(false);
  expect(runBridgeJob).not.toHaveBeenCalled();
  expect(useLogicBridgeStore.getState()).toBe(before);
});
