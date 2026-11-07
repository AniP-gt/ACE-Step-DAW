import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../store/projectStore';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { applyLogicReferenceTiming } from '../logicBridgeTiming';

vi.mock('../projectStorage', () => ({ saveProject: vi.fn() }));

describe('Logic reference timing', () => {
  beforeEach(() => {
    useProjectStore.getState().createProject({ bpm: 120 });
    useLogicBridgeStore.setState({ bindings: [] });
  });

  it('sets the first empty workspace to the captured 150 BPM and 7/8 meter', () => {
    const projectId = useProjectStore.getState().project?.id ?? '';
    applyLogicReferenceTiming({ tempo: 150, timeSignature: [7, 8] }, projectId);
    expect(useProjectStore.getState().project).toMatchObject({ bpm: 150, timeSignature: 7, timeSignatureDenominator: 8 });
  });

  it.each([{ tempo: 150, timeSignature: [3, 4] }, { tempo: 120, timeSignature: [7, 8] }])('rejects incompatible later references without retiming existing music: %j', capture => {
    const projectId = useProjectStore.getState().project?.id ?? '';
    const track = useProjectStore.getState().addTrack('keyboard', 'sample');
    useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 4, prompt: 'Existing reference', lyrics: '' });
    useLogicBridgeStore.setState({ bindings: [{ projectId }] });
    expect(() => applyLogicReferenceTiming(capture, projectId)).toThrow('REFERENCE_TIMING_CONFLICT');
    expect(useProjectStore.getState().project).toMatchObject({ bpm: 120, timeSignature: 4, timeSignatureDenominator: 4 });
  });
});
