import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createGenerationFixture, modelId } from '../support/logicBridgeGenerationFixture';
import { waitForBrowserStores, type E2EBrowserWindow } from '../support/browserStores';

test('native intents survive reload and produce one isolated layer through the real bridge executor', async ({ page }) => {
  test.setTimeout(240_000);
  const fixture = await createGenerationFixture();
  const toggleHistory: Record<string, unknown>[] = [];
  let togglePhase = 'startup';
  try {
    await page.addInitScript((backend) => {
      localStorage.setItem('ace-step-welcome-seen', 'true');
      localStorage.setItem('ace-step-daw-backend-url', backend);
    }, fixture.modelUrl);
    await page.goto('/');
    await waitForBrowserStores(page);
    const projectId = await page.evaluate(() => {
      const store = (window as E2EBrowserWindow).__store.getState();
      store.createProject({ name: 'Bridge integration', bpm: 120, keyScale: 'C major' });
      return (window as E2EBrowserWindow).__store.getState().project!.id;
    });
    const connect = async () => {
      const pair = await fixture.pairing('executor', projectId);
      await page.evaluate(async (code) => {
        const modelPath = '/src/store/modelStore.ts';
        const bridgePath = '/src/services/logicBridge.ts';
        const model = await import(/* @vite-ignore */ modelPath);
        await model.useModelStore.getState().refreshModels();
        await (await import(/* @vite-ignore */ bridgePath)).connectBridge(code);
      }, String(pair.code));
    };
    await connect();
    const prepare = await fixture.request(fixture.token, '/native-requests', {
      sessionId: fixture.sessionId, kind: 'prepare', clientRequestId: 'prepare-browser', captureId: fixture.capture.captureId,
    });
    let prepared: Record<string, unknown> = {};
    await expect.poll(async () => {
      prepared = await fixture.request(fixture.token, `/native-requests/${prepare.requestId}`);
      return prepared.state;
    }, { timeout: 20_000 }).toBe('prepared');
    expect(prepared.projectId).toBe(projectId);
    const bindings = await fixture.request(fixture.token, `/bindings?sessionId=${fixture.sessionId}`);
    const binding = (bindings.bindings as Record<string, unknown>[]).find(item => item.bindingId === prepared.bindingId);
    expect(binding).toMatchObject({ projectId, captureId: fixture.capture.captureId, canonicalSha256: fixture.capture.canonicalSha256 });
    const clipId = String(binding!.clipId);
    await page.reload();
    await waitForBrowserStores(page);
    await expect.poll(async () => page.evaluate(({ clipId: id, expectedProject }) => {
      const store = (window as E2EBrowserWindow).__store.getState();
      const clip = store.getClipById(id);
      return store.project?.id === expectedProject && clip?.generationStatus === 'ready' && !!clip.isolatedAudioKey;
    }, { clipId, expectedProject: projectId }), { timeout: 15_000 }).toBe(true);
    const persisted = await page.evaluate(async (id) => {
      const clip = (window as E2EBrowserWindow).__store.getState().getClipById(id)!;
      const path = '/src/services/audioFileManager.ts';
      const blob: Blob | undefined = await (await import(/* @vite-ignore */ path)).loadAudioBlobByKey(clip.isolatedAudioKey);
      if (!blob) return null;
      const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return { size: blob.size, hash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') };
    }, clipId);
    expect(persisted?.size).toBeGreaterThan(44);
    expect(persisted?.hash).toBe(fixture.capture.canonicalSha256);
    // The previous executor lease expires after the reloaded page stops polling.
    await page.waitForTimeout(31_000);
    await connect();
    await expect.poll(async () => (await fixture.request(fixture.token, `/native-readiness?sessionId=${fixture.sessionId}`)).ready, { timeout: 15_000 }).toBe(true);
    const generation = await fixture.request(fixture.token, '/native-requests', {
      sessionId: fixture.sessionId, kind: 'generation', clientRequestId: 'generation-browser', preparedRequestId: prepare.requestId, instrument: 'keyboard', prompt: 'A clear piano layer',
    });
    let receipt: Record<string, unknown> = {};
    await expect.poll(async () => {
      receipt = await fixture.request(fixture.token, `/native-requests/${generation.requestId}`);
      return receipt.state;
    }, { timeout: 20_000 }).toBe('submitted');
    let job: Record<string, unknown> = {};
    await expect.poll(async () => {
      job = await fixture.request(fixture.token, `/jobs/${receipt.jobId}`);
      return job.state;
    }, { timeout: 30_000 }).toBe('ready');
    expect(job).toMatchObject({ projectId, captureId: fixture.capture.captureId, bindingId: prepared.bindingId, canonicalSha256: fixture.capture.canonicalSha256, modelId, instrument: 'keyboard' });
    const results = await fixture.request(fixture.token, `/results?sessionId=${fixture.sessionId}`);
    expect(results.results).toHaveLength(1);
    expect((results.results as Record<string, unknown>[])[0]).toMatchObject({ jobId: job.jobId });
    expect(await fixture.jobCount()).toBe(1);
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0].fields).toMatchObject({ task_type: 'lego', track_name: 'keyboard', model: modelId });
    const result = await fixture.request(fixture.token, `/results/${job.resultId}`);
    const output = await fixture.asset(String(result.assetId));
    expect(createHash('sha256').update(output).digest('hex')).toBe(result.sha256);
    expect(output.subarray(0, 4).toString()).toBe('RIFF');
    expect(output.readUInt16LE(20)).toBe(3);
    expect(output.readUInt16LE(22)).toBe(2);
    expect(output.readUInt32LE(24)).toBe(48_000);
    expect(output.length).toBe(44 + 96_000 * 8);
    expect(fixture.submissions[0].sourceSize).toBeGreaterThan(44);
    const clips = await page.evaluate(() => (window as E2EBrowserWindow).__store.getState().project!.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, status: clip.generationStatus, key: clip.isolatedAudioKey })));
    expect(clips).toHaveLength(2);
    expect(clips.filter(clip => clip.status === 'ready' && clip.key)).toHaveLength(2);
    const executorPath = '/src/store/logicBridgeStore.ts';
    const executorId = await page.evaluate(async path => (await import(/* @vite-ignore */ path)).useLogicBridgeStore.getState().executorId, executorPath);
    for (let cycle = 1; cycle <= 10; cycle++) {
      for (const loaded of [false, true]) {
        togglePhase = `${cycle}:${loaded ? 'loaded' : 'unloaded'}`;
        fixture.setLoaded(loaded);
        await page.evaluate(async () => { const path = '/src/store/modelStore.ts'; await (await import(/* @vite-ignore */ path)).useModelStore.getState().refreshModels(); });
        await expect.poll(async () => {
          const state = await fixture.request(fixture.token, `/native-readiness?sessionId=${fixture.sessionId}`);
          const store = await page.evaluate(async path => {
            const bridge = (await import(/* @vite-ignore */ path)).useLogicBridgeStore.getState();
            const modelPath = '/src/store/modelStore.ts'; const model = (await import(/* @vite-ignore */ modelPath)).useModelStore.getState();
            return { executorId: bridge.executorId, connected: bridge.connected, error: bridge.error, verifiedModelId: bridge.verifiedModelId, models: model.availableModels };
          }, executorPath);
          toggleHistory.push({ phase: togglePhase, at: Date.now(), readiness: state, store });
          return store.executorId === executorId && store.connected && (loaded ? state.ready === true && store.verifiedModelId === modelId : state.reason === 'LEGO_UNAVAILABLE' && store.verifiedModelId === null);
        }, { timeout: 15_000 }).toBe(true);
        if (!loaded && cycle === 1) {
          await expect(fixture.request(fixture.token, '/native-requests', { sessionId: fixture.sessionId, kind: 'generation', clientRequestId: 'unloaded', preparedRequestId: prepare.requestId, instrument: 'keyboard' })).rejects.toThrow('LEGO_UNAVAILABLE');
          expect(await fixture.jobCount()).toBe(1);
          expect(fixture.submissions).toHaveLength(1);
        }
      }
    }
    togglePhase = 'complete';
    await writeFile(join(process.cwd(), '.codex/omo/evidence/bridge-plugin-generation-ui/resume6/integration/inventory-toggle-history.json'), JSON.stringify({ toggleHistory, inventoryReads: fixture.inventoryReads, bridgeState: await fixture.snapshot() }, null, 2));
    await page.evaluate(id => (window as E2EBrowserWindow).__store.getState().removeClip(id), clipId);
    await expect.poll(async () => (await fixture.request(fixture.token, `/native-readiness?sessionId=${fixture.sessionId}`)).reason, { timeout: 15_000 }).toBe('STALE_BINDING');
    await expect(fixture.request(fixture.token, '/native-requests', { sessionId: fixture.sessionId, kind: 'generation', clientRequestId: 'stale', preparedRequestId: prepare.requestId, instrument: 'keyboard' })).rejects.toThrow('STALE_BINDING');
    expect(await fixture.jobCount()).toBe(1);
    expect(fixture.submissions).toHaveLength(1);
  } catch (error) {
    const readiness = await fixture.request(fixture.token, `/native-readiness?sessionId=${fixture.sessionId}`).catch(() => null);
    const stores = await page.evaluate(async () => {
      const bridgePath = '/src/store/logicBridgeStore.ts'; const modelPath = '/src/store/modelStore.ts';
      const bridge = (await import(/* @vite-ignore */ bridgePath)).useLogicBridgeStore.getState();
      const model = (await import(/* @vite-ignore */ modelPath)).useModelStore.getState();
      return { bridge: { connected: bridge.connected, executorId: bridge.executorId, error: bridge.error, verifiedModelId: bridge.verifiedModelId }, models: model.availableModels, clips: (window as E2EBrowserWindow).__store.getState().project?.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, duration: clip.duration, status: clip.generationStatus, source: clip.source, hasAudio: !!clip.isolatedAudioKey })) };
    }).catch(() => null);
    await writeFile(join(process.cwd(), '.codex/omo/evidence/bridge-plugin-generation-ui/resume6/integration/normal-failure-diagnostic.json'), JSON.stringify({ togglePhase, toggleHistory, inventoryReads: fixture.inventoryReads, readiness, stores, bridgeState: await fixture.snapshot() }, null, 2));
    throw error;
  } finally {
    await page.close();
    await fixture.close();
  }
});

test('editing a prepared reference during canonical download prevents model submission', async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await createGenerationFixture();
  let releaseDownload: (() => void) | undefined;
  try {
    await page.addInitScript(backend => {
      localStorage.setItem('ace-step-welcome-seen', 'true');
      localStorage.setItem('ace-step-daw-backend-url', backend);
    }, fixture.modelUrl);
    await page.goto('/'); await waitForBrowserStores(page);
    const projectId = await page.evaluate(() => {
      const store = (window as E2EBrowserWindow).__store.getState();
      store.createProject({ name: 'Bridge stale download', bpm: 120, keyScale: 'C major' });
      return (window as E2EBrowserWindow).__store.getState().project!.id;
    });
    const pair = await fixture.pairing('executor', projectId);
    await page.evaluate(async code => {
      const modelPath = '/src/store/modelStore.ts'; const bridgePath = '/src/services/logicBridge.ts';
      await (await import(/* @vite-ignore */ modelPath)).useModelStore.getState().refreshModels();
      await (await import(/* @vite-ignore */ bridgePath)).connectBridge(code);
    }, String(pair.code));
    const prepare = await fixture.request(fixture.token, '/native-requests', { sessionId: fixture.sessionId, kind: 'prepare', clientRequestId: 'delayed-prepare', captureId: fixture.capture.captureId });
    let prepared: Record<string, unknown> = {};
    await expect.poll(async () => { prepared = await fixture.request(fixture.token, `/native-requests/${prepare.requestId}`); return prepared.state; }, { timeout: 20_000 }).toBe('prepared');
    const bindings = await fixture.request(fixture.token, `/bindings?sessionId=${fixture.sessionId}`);
    const binding = (bindings.bindings as Record<string, unknown>[]).find(item => item.bindingId === prepared.bindingId)!;
    let observedDownload: (() => void) | undefined;
    const downloadStarted = new Promise<void>(resolve => { observedDownload = resolve; });
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    await page.route(`**/v1/assets/${fixture.capture.canonicalAssetId}`, async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const response = await route.fetch();
      observedDownload?.();
      await gate;
      await route.fulfill({ response });
    });
    const generation = await fixture.request(fixture.token, '/native-requests', { sessionId: fixture.sessionId, kind: 'generation', clientRequestId: 'delayed-generation', preparedRequestId: prepare.requestId, instrument: 'keyboard' });
    await Promise.race([downloadStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Canonical asset request did not start')), 20_000))]);
    await page.evaluate(id => (window as E2EBrowserWindow).__store.getState().updateClip(id, { duration: 1.5 }), String(binding.clipId));
    releaseDownload();
    let receipt: Record<string, unknown> = {};
    await expect.poll(async () => { receipt = await fixture.request(fixture.token, `/native-requests/${generation.requestId}`); return receipt.state; }, { timeout: 15_000 }).toBe('submitted');
    let job: Record<string, unknown> = {};
    await expect.poll(async () => { job = await fixture.request(fixture.token, `/jobs/${receipt.jobId}`); return job.state; }, { timeout: 20_000 }).toBe('failed');
    expect(String(job.error)).toContain('STALE_BINDING');
    expect(fixture.submissions).toHaveLength(0);
    await expect.poll(async () => (await fixture.request(fixture.token, `/native-readiness?sessionId=${fixture.sessionId}`)).reason, { timeout: 20_000 }).toBe('STALE_BINDING');
    expect(await fixture.jobCount()).toBe(1);
  } finally {
    releaseDownload?.();
    await page.close(); await fixture.close();
  }
});

test('two native owners cannot submit overlapping generations', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const evidence = join(process.cwd(), '.codex/omo/evidence/bridge-plugin-generation-ui/resume13/integration');
  const fixture = await createGenerationFixture({ evidence });
  let releasePoll: (() => void) | undefined;
  try {
    const pairB = await fixture.pairing('native');
    const ownerB = await fixture.request('', '/pairings/claim', { code: pairB.code });
    const tokenB = String(ownerB.token);
    const pcm = (await fixture.asset(String(fixture.capture.canonicalAssetId))).subarray(44);
    const sha256 = createHash('sha256').update(pcm).digest('hex');
    const captureB = await fixture.request(tokenB, '/captures', { sessionId: fixture.sessionId, instanceId: 'second-native-owner', sampleRate: 48_000, channels: 2, expectedFrames: 96_000, hostStartSample: 0, tempo: 120, timeSignature: [4, 4] });
    const upload = await fetch(`http://127.0.0.1:${process.env.VITE_LOGIC_BRIDGE_PORT}/v1/captures/${captureB.captureId}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${tokenB}`, 'X-Bridge-Protocol': '1', 'X-Start-Frame': '0', 'X-Chunk-SHA256': sha256 }, body: pcm });
    expect(upload.ok).toBe(true);
    const finalizedB = await fixture.request(tokenB, `/captures/${captureB.captureId}/finalize`, { sha256 });
    expect(finalizedB.captureId).not.toBe(fixture.capture.captureId);
    await page.addInitScript(backend => {
      localStorage.setItem('ace-step-welcome-seen', 'true');
      localStorage.setItem('ace-step-daw-backend-url', backend);
    }, fixture.modelUrl);
    await page.goto('/'); await waitForBrowserStores(page);
    const projectId = await page.evaluate(() => {
      const store = (window as E2EBrowserWindow).__store.getState();
      store.createProject({ name: 'Two native owners', bpm: 120, keyScale: 'C major' });
      return (window as E2EBrowserWindow).__store.getState().project!.id;
    });
    const executorPair = await fixture.pairing('executor', projectId);
    await page.evaluate(async code => {
      const modelPath = '/src/store/modelStore.ts'; const bridgePath = '/src/services/logicBridge.ts';
      await (await import(/* @vite-ignore */ modelPath)).useModelStore.getState().refreshModels();
      await (await import(/* @vite-ignore */ bridgePath)).connectBridge(code);
    }, String(executorPair.code));
    const prepareA = await fixture.request(fixture.token, '/native-requests', { sessionId: fixture.sessionId, kind: 'prepare', clientRequestId: 'owner-a-prepare', captureId: fixture.capture.captureId });
    let preparedA: Record<string, unknown> = {};
    await expect.poll(async () => { preparedA = await fixture.request(fixture.token, `/native-requests/${prepareA.requestId}`); return preparedA.state; }, { timeout: 20_000 }).toBe('prepared');
    const prepareB = await fixture.request(tokenB, '/native-requests', { sessionId: fixture.sessionId, kind: 'prepare', clientRequestId: 'owner-b-prepare', captureId: finalizedB.captureId });
    let preparedB: Record<string, unknown> = {};
    await expect.poll(async () => { preparedB = await fixture.request(tokenB, `/native-requests/${prepareB.requestId}`); return preparedB.state; }, { timeout: 20_000 }).toBe('prepared');
    expect(preparedA.projectId).toBe(projectId); expect(preparedB.projectId).toBe(projectId);
    expect(preparedB.bindingId).not.toBe(preparedA.bindingId);
    const bindings = (await fixture.request(fixture.token, `/bindings?sessionId=${fixture.sessionId}`)).bindings as Record<string, unknown>[];
    const bindingA = bindings.find(binding => binding.bindingId === preparedA.bindingId);
    const bindingB = bindings.find(binding => binding.bindingId === preparedB.bindingId);
    expect(bindingA).toMatchObject({ captureId: fixture.capture.captureId, projectId });
    expect(bindingB).toMatchObject({ captureId: finalizedB.captureId, projectId });
    expect(bindingA?.clipId).toBeTruthy(); expect(bindingB?.clipId).toBeTruthy(); expect(bindingA?.clipId).not.toBe(bindingB?.clipId);
    const imported = await page.evaluate(() => (window as E2EBrowserWindow).__store.getState().project!.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, status: clip.generationStatus, key: clip.isolatedAudioKey })));
    expect(imported.filter(clip => [bindingA?.clipId, bindingB?.clipId].includes(clip.id) && clip.status === 'ready' && clip.key)).toHaveLength(2);
    let observePoll: (() => void) | undefined;
    const pollStarted = new Promise<void>(resolve => { observePoll = resolve; });
    const gate = new Promise<void>(resolve => { releasePoll = resolve; });
    await page.route('**/v1/executor/native-requests?*', async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      observePoll?.(); await gate; await route.continue();
    });
    await Promise.race([pollStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Executor request poll did not start')), 15_000))]);
    const generationA = await fixture.request(fixture.token, '/native-requests', { sessionId: fixture.sessionId, kind: 'generation', clientRequestId: 'owner-a-generation', preparedRequestId: prepareA.requestId, instrument: 'keyboard', prompt: 'First owner' });
    const generationB = await fixture.request(tokenB, '/native-requests', { sessionId: fixture.sessionId, kind: 'generation', clientRequestId: 'owner-b-generation', preparedRequestId: prepareB.requestId, instrument: 'bass', prompt: 'Second owner' });
    expect(generationA.state).toBe('pending'); expect(generationB.state).toBe('pending');
    expect(await fixture.jobCount()).toBe(0); expect(fixture.submissions).toHaveLength(0);
    releasePoll();
    let receiptA: Record<string, unknown> = {}; let receiptB: Record<string, unknown> = {};
    await expect.poll(async () => { receiptA = await fixture.request(fixture.token, `/native-requests/${generationA.requestId}`); return receiptA.state; }, { timeout: 25_000 }).toBe('submitted');
    await expect.poll(async () => { receiptB = await fixture.request(tokenB, `/native-requests/${generationB.requestId}`); return receiptB.state; }, { timeout: 25_000 }).toBe('failed');
    expect(receiptB.error).toBe('PROJECT_BUSY'); expect(receiptB.jobId).toBeUndefined();
    let job: Record<string, unknown> = {};
    await expect.poll(async () => { job = await fixture.request(fixture.token, `/jobs/${receiptA.jobId}`); return job.state; }, { timeout: 30_000 }).toBe('ready');
    expect(job).toMatchObject({ projectId, captureId: fixture.capture.captureId, bindingId: preparedA.bindingId });
    expect(await fixture.jobCount()).toBe(1); expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0].fields).toMatchObject({ task_type: 'lego', track_name: 'keyboard', model: modelId });
    await testInfo.attach('two-native-owners', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    releasePoll?.(); await page.close(); await fixture.close();
  }
});
