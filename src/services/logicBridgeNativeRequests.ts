import { useProjectStore } from '../store/projectStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { useModelStore } from '../store/modelStore';
import { useGenerationStore } from '../store/generationStore';
import { TRACK_NAMES } from '../constants/tracks';
import { loadAudioBlobByKey } from './audioFileManager';
import { ExplicitContextError, requireLegoModel, validateContextRange } from './explicitContextGeneration';
import { attachLogicCapture, refreshBridge } from './logicBridge';
import { bridgeJson, BridgeRequestError, objects, stringField, type BridgeObject } from './logicBridgeClient';

type Clip = ReturnType<ReturnType<typeof useProjectStore.getState>['getClipById']>;
export function nativeReferenceValid(receipt: BridgeObject, binding: BridgeObject | undefined, capture: BridgeObject | undefined, clip: Partial<NonNullable<Clip>> | undefined): boolean {
  return !!binding && !!capture && !!clip && binding.bindingId === receipt.bindingId && binding.captureId === receipt.captureId && binding.projectId === receipt.projectId && binding.clipId === clip.id && capture.captureId === receipt.captureId && capture.state === 'ready' && binding.canonicalSha256 === capture.canonicalSha256 && typeof capture.canonicalFrameCount === 'number' && Number.isSafeInteger(capture.canonicalFrameCount) && capture.canonicalFrameCount > 0 && clip.startTime === 0 && clip.duration === capture.canonicalFrameCount / 48000 && (clip.audioDuration === undefined || clip.audioDuration === clip.duration) && (clip.audioOffset ?? 0) === 0 && (clip.contentOffset ?? 0) === 0 && (clip.timeStretchRate ?? 1) === 1 && (clip.pitchShift ?? 0) === 0 && (clip.fadeInDuration ?? 0) === 0 && (clip.fadeOutDuration ?? 0) === 0 && !(clip.warpMarkers?.length) && !(clip.gainEnvelope?.length) && clip.generationStatus === 'ready' && clip.source === 'uploaded' && typeof clip.isolatedAudioKey === 'string' && clip.isolatedAudioKey.length > 0;
}

export async function validReference(receipt: BridgeObject, guard: () => void): Promise<boolean> {
  const state = useLogicBridgeStore.getState();
  const binding = state.bindings.find(item => item.bindingId === receipt.bindingId);
  const capture = state.captures.find(item => item.captureId === receipt.captureId);
  const clip = binding && typeof binding.clipId === 'string' ? useProjectStore.getState().getClipById(binding.clipId) : undefined;
  if (!nativeReferenceValid(receipt, binding, capture, clip) || !clip?.isolatedAudioKey || !capture) return false;
  const blob = await loadAudioBlobByKey(clip.isolatedAudioKey);
  guard();
  if (!blob) return false;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  guard();
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const current = useLogicBridgeStore.getState();
  return hash === capture.canonicalSha256 && useProjectStore.getState().getClipById(clip.id) === clip && nativeReferenceValid(receipt, current.bindings.find(item => item.bindingId === receipt.bindingId), current.captures.find(item => item.captureId === receipt.captureId), clip);
}

export async function processNativeRequests(context: { token: string; sessionId: string; projectId: string; guard: () => void }): Promise<void> {
  const { token, sessionId, projectId, guard } = context;
  const response = await bridgeJson(token, `/executor/native-requests?sessionId=${encodeURIComponent(sessionId)}`);
  guard();
  for (const request of objects(response, 'requests')) {
    guard();
    if (request.sessionId !== sessionId || request.projectId !== projectId) continue;
    const id = stringField(request, 'requestId');
    const path = `/native-requests/${encodeURIComponent(id)}`;
    if (request.kind === 'prepare' && request.state === 'prepared') {
      if (!await validReference(request, guard)) {
        guard();
        await bridgeJson(token, `${path}/invalidate`, { sessionId, error: 'STALE_BINDING' });
        guard();
      }
    } else if (request.kind === 'prepare' && request.state === 'pending') {
      try {
        const binding = await attachLogicCapture({ sessionId, projectId, captureId: request.captureId, clientRequestId: id });
        guard();
        const bindingId = stringField(binding, 'bindingId');
        if (!await validReference({ ...request, bindingId }, guard)) throw new ExplicitContextError('STALE_BINDING');
        guard();
        await bridgeJson(token, `${path}/prepared`, { sessionId, bindingId });
        guard();
      } catch (error) {
        guard();
        if (!(error instanceof ExplicitContextError)) throw error;
        await bridgeJson(token, `${path}/fail`, { sessionId, error: error.message });
        guard();
      }
    } else if (request.kind === 'generation' && request.state === 'pending') {
      await refreshBridge(); guard();
      let failure: string | undefined;
      if (!await validReference(request, guard)) {
        const parentId = stringField(request, 'preparedRequestId');
        guard();
        await bridgeJson(token, `/native-requests/${encodeURIComponent(parentId)}/invalidate`, { sessionId, error: 'STALE_BINDING' });
        guard();
        continue;
      } else {
        try {
          const modelId = useLogicBridgeStore.getState().verifiedModelId;
          if (!modelId) throw new ExplicitContextError('LEGO_UNAVAILABLE');
          requireLegoModel(useModelStore.getState().availableModels, modelId);
          if (!TRACK_NAMES.some(name => name === request.instrument)) throw new ExplicitContextError('UNSUPPORTED_INSTRUMENT');
          const capture = useLogicBridgeStore.getState().captures.find(item => item.captureId === request.captureId);
          if (!capture || typeof capture.canonicalFrameCount !== 'number') throw new ExplicitContextError('STALE_BINDING');
          validateContextRange(capture.canonicalFrameCount, 0, capture.canonicalFrameCount);
          if (useGenerationStore.getState().isGenerating || useGenerationStore.getState().backendOccupancyJobId) throw new ExplicitContextError('BACKEND_BUSY');
        } catch (error) { failure = error instanceof Error ? error.message : 'GENERATION_UNAVAILABLE'; }
      }
      guard();
      if (failure) {
        await bridgeJson(token, `${path}/fail`, { sessionId, error: failure });
        guard();
      } else {
        try {
          await bridgeJson(token, `${path}/submit`, { sessionId });
          guard();
        } catch (error) {
          guard();
          if (!(error instanceof BridgeRequestError) || error.status !== 409 || !['STALE_BINDING', 'PROJECT_BUSY'].includes(error.code)) throw error;
          try {
            await bridgeJson(token, `${path}/fail`, { sessionId, error: error.code });
            guard();
          } catch (closeError) {
            guard();
            if (!(closeError instanceof BridgeRequestError) || closeError.status !== 409 || closeError.code !== 'INVALID_TRANSITION') throw closeError;
          }
        }
      }
    }
  }
}
