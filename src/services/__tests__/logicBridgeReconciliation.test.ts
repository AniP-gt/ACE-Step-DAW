import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileBridgeJob } from '../logicBridgeReconciliation';
import { useGenerationStore } from '../../store/generationStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';

describe('backend occupancy reconciliation', () => {
  beforeEach(() => {
    useGenerationStore.setState(useGenerationStore.getInitialState(), true);
    useLogicBridgeStore.setState(useLogicBridgeStore.getInitialState(), true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([{ state: 'canceled', status: 1, outcome: 'completed' }, { state: 'interrupted', status: 2, outcome: 'failed' }])('holds the real generation lock until a $state task is confirmed terminal', async ({ state, status, outcome }) => {
    let terminal = false;
    const receipts: unknown[] = [];
    const job = { jobId: 'job', state, backendTaskId: 'backend', backendOccupancy: 'unknown' };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/query_result')) {
        expect(init.signal?.aborted).toBe(false);
        return new Response(JSON.stringify({ data: [{ task_id: 'backend', status: terminal ? status : 0, result: 'late output must not be downloaded' }] }));
      }
      receipts.push(typeof init.body === 'string' ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify({ ...job, backendOccupancy: 'released' }));
    });
    await reconcileBridgeJob(job, 'credential');
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(false);
    expect(receipts).toEqual([]);
    terminal = true;
    await reconcileBridgeJob(job, 'credential');
    expect(receipts).toEqual([{ backendTaskId: 'backend', outcome }]);
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(true);
    expect(useLogicBridgeStore.getState().jobs[0]?.state).toBe(state);
  });

  it('keeps unknown submission occupied without issuing a new backend task', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await reconcileBridgeJob({ jobId: 'unknown', state: 'interrupted', backendOccupancy: 'unknown' }, 'credential');
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(false);
    expect(useLogicBridgeStore.getState().error).toContain('unknown');
    expect(fetch).not.toHaveBeenCalled();
    const persisted = localStorage.getItem('ace-step-daw-generation');
    useGenerationStore.setState(useGenerationStore.getInitialState(), true);
    if (persisted) localStorage.setItem('ace-step-daw-generation', persisted);
    await useGenerationStore.persist.rehydrate();
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(false);
  });

  it('keeps occupancy when the backend status endpoint cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => new Response('Unavailable', { status: 503 }));
    await expect(reconcileBridgeJob({ jobId: 'offline', state: 'canceled', backendTaskId: 'backend', backendOccupancy: 'unknown' }, 'credential')).rejects.toThrow('queryResult failed');
    expect(useGenerationStore.getState().tryAcquireGenerationLock()).toBe(false);
  });
  it('rejects an old backend response after the connection changes', async () => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async () => { reached(); await wait; return new Response(JSON.stringify({ data: [{ task_id: 'backend', status: 1 }] })); });
    vi.stubGlobal('fetch', fetch);
    let current = true;
    const pending = reconcileBridgeJob({ jobId: 'old', state: 'interrupted', backendTaskId: 'backend', backendOccupancy: 'unknown' }, 'old', () => { if (!current) throw new Error('STALE_BINDING'); });
    await entered;
    current = false;
    useLogicBridgeStore.setState({ error: 'new connection', jobs: [] });
    release();
    await expect(pending).rejects.toThrow('STALE_BINDING');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useLogicBridgeStore.getState().error).toBe('new connection');
    expect(useLogicBridgeStore.getState().jobs).toEqual([]);
    expect(useGenerationStore.getState().backendOccupancyJobId).toBe('old');
  });

});
