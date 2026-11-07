import { mkdir, readFile, writeFile, rename, appendFile, open, unlink, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { BridgeCapture, BridgeCredential, BridgeJob, BridgeResult, BridgeSession, ContextBinding } from '../../shared/logic-bridge/types';
import { BridgeError } from './validation';
import { hash } from './audio';
export interface BridgeState {
  sessions: BridgeSession[];
  credentials: BridgeCredential[];
  captures: BridgeCapture[];
  bindings: ContextBinding[];
  jobs: BridgeJob[];
  results: BridgeResult[];
  assets: { assetId: string; sessionId: string; sha256: string; size: number }[];
}
export async function storage(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, 'service.lock');
  try { const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new BridgeError(409, 'SERVICE_LOCKED', 'Service lock exists; verify the previous process exited before removing service.lock'); throw error; }
  try {
    await mkdir(join(root, 'assets'), { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'staging'), { recursive: true, mode: 0o700 });
    let controlToken: string;
    try { controlToken = await readFile(join(root, 'control-token'), 'utf8'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      controlToken = randomBytes(32).toString('hex');
      await writeFile(join(root, 'control-token'), controlToken, { mode: 0o600 });
    }
    let state: BridgeState;
    try { state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      state = { sessions: [], credentials: [], captures: [], bindings: [], jobs: [], results: [], assets: [] };
    }
    const save = async () => {
      const temporary = join(root, `${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, join(root, 'state.json'));
    };
    for (const file of await readdir(join(root, 'staging'))) await rm(join(root, 'staging', file), { force: true });
    state.jobs = state.jobs.map(job => ['queued', 'dispatched', 'running', 'exporting'].includes(job.state) ? { ...job, state: 'interrupted', error: 'SUBMISSION_OUTCOME_UNKNOWN', backendOccupancy: job.state === 'queued' ? 'released' : 'unknown' } : job);
    state.captures = state.captures.map(capture => capture.state === 'receiving' ? { ...capture, state: 'failed' } : capture);
    const invalidAssets = new Set<string>();
    for (const asset of state.assets) {
      try { if (hash(await readFile(join(root, 'assets', asset.assetId))) !== asset.sha256) invalidAssets.add(asset.assetId); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; invalidAssets.add(asset.assetId); }
    }
    state.captures = state.captures.map(capture => capture.state === 'ready' && (invalidAssets.has(capture.canonicalAssetId ?? '') || invalidAssets.has(capture.originalAssetId ?? '')) ? { ...capture, state: 'failed' } : capture);
    state.jobs = state.jobs.map(job => {
      const result = state.results.find(item => item.resultId === job.resultId);
      return job.state === 'ready' && (!result || invalidAssets.has(result.assetId)) ? { ...job, state: 'failed', error: 'RESULT_UNAVAILABLE' } : job;
    });
    await save();
    let previousEvents: unknown[] = [];
    try { previousEvents = (await readFile(join(root, 'journal.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    return { state, controlToken, previousEvents, save, journal: (event: unknown) => appendFile(join(root, 'journal.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 }), close: () => unlink(lockPath) };
  } catch (error) { await unlink(lockPath); throw error; }
}
