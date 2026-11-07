import { useProjectStore } from '../store/projectStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { ExplicitContextError } from './explicitContextGeneration';
import { numberField, type BridgeObject } from './logicBridgeClient';

export interface LogicSourceTiming {
  readonly bpm: number;
  readonly numerator: number;
  readonly denominator: number;
}

export function readLogicSourceTiming(capture: BridgeObject): LogicSourceTiming {
  const bpm = numberField(capture, 'tempo');
  const meter = capture.timeSignature;
  if (bpm <= 0 || !Array.isArray(meter) || meter.length !== 2 || typeof meter[0] !== 'number' || typeof meter[1] !== 'number' || !Number.isSafeInteger(meter[0]) || meter[0] < 1 || ![1, 2, 4, 8, 16, 32, 64].includes(meter[1])) {
    throw new ExplicitContextError('INVALID_REFERENCE_TIMING: Supply a valid tempo and meter for the source.');
  }
  return { bpm, numerator: meter[0], denominator: meter[1] };
}

export function applyLogicReferenceTiming(capture: BridgeObject, projectId: string): void {
  const timing = readLogicSourceTiming(capture);
  const project = useProjectStore.getState().project;
  if (!project || project.id !== projectId) throw new ExplicitContextError('STALE_BINDING');
  if (project.tempoMap?.length || project.timeSignatureMap?.length) throw new ExplicitContextError('REFERENCE_TIMING_CONFLICT: Use a fixed-tempo bridge workspace.');
  const firstReference = project.tracks.every(track => track.clips.length === 0) && !useLogicBridgeStore.getState().bindings.some(binding => binding.projectId === projectId);
  if (firstReference) {
    useProjectStore.getState().updateProject({ bpm: timing.bpm, timeSignature: timing.numerator, timeSignatureDenominator: timing.denominator });
  } else if (project.bpm !== timing.bpm || project.timeSignature !== timing.numerator || (project.timeSignatureDenominator ?? 4) !== timing.denominator) {
    throw new ExplicitContextError('REFERENCE_TIMING_CONFLICT: This source has a different tempo or meter. Use a separate bridge project.');
  }
}
