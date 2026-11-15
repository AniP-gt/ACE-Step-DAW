import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { storage } from '../../server/logic-bridge/storage';
import type { BridgeJob, NativeRequestRecord } from '../../shared/logic-bridge/types';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const root = async () => { const path = await mkdtemp(join(tmpdir(), 'bridge-native-storage-')); roots.push(path); return path; };
const legacy = () => ({ sessions: [], credentials: [], captures: [], bindings: [], jobs: [], results: [], assets: [] });

it('loads and saves a legacy state without native requests', async () => {
  const path = await root();
  await writeFile(join(path, 'state.json'), JSON.stringify(legacy()));
  const service = await storage(path);
  expect(service.state.nativeRequests).toEqual([]);
  expect(JSON.parse(await readFile(join(path, 'state.json'), 'utf8')).nativeRequests).toEqual([]);
  await service.close();
});

it('persists receipt linkage and preserves interruption occupancy across restart', async () => {
  const path = await root();
  const first = await storage(path);
  const receipt: NativeRequestRecord = { kind: 'generation', requestId: 'native-request', sessionId: 'session', ownerCredentialHash: 'owner-hash', clientRequestId: 'caller-id', payloadFingerprint: 'fingerprint', projectId: 'project', captureId: 'capture', preparedRequestId: 'prepare', bindingId: 'binding', instrument: 'bass', prompt: '', jobClientRequestId: 'internal-id', state: 'submitted', jobId: 'job' };
  const job: BridgeJob = { jobId: 'job', sessionId: 'session', projectId: 'project', captureId: 'capture', bindingId: 'binding', clientRequestId: 'internal-id', canonicalSha256: 'hash', startFrame: 0, endFrame: 100, instrument: 'bass', prompt: '', modelId: 'model', seed: 0, state: 'running', parameterHash: 'hash', backendOccupancy: 'occupied' };
  first.state.nativeRequests.push(receipt);
  first.state.jobs.push(job, { ...job, jobId: 'queued', state: 'queued', backendOccupancy: 'reserved' });
  await first.save();
  expect(JSON.parse(await readFile(join(path, 'state.json'), 'utf8')).nativeRequests).toEqual([receipt]);
  await first.close();
  const second = await storage(path);
  expect(second.state.nativeRequests).toEqual([receipt]);
  expect(second.state.jobs.map(({ state, backendOccupancy }) => ({ state, backendOccupancy }))).toEqual([{ state: 'interrupted', backendOccupancy: 'unknown' }, { state: 'interrupted', backendOccupancy: 'released' }]);
  const persisted = JSON.parse(await readFile(join(path, 'state.json'), 'utf8'));
  expect(persisted.nativeRequests).toEqual([receipt]);
  expect(persisted.jobs[0]).toMatchObject({ state: 'interrupted', backendOccupancy: 'unknown' });
  await second.close();
});
