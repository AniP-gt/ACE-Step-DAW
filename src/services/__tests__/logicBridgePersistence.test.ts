import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore, flushProjectReferencePersistence } from '../../store/projectStore';
import * as storage from '../projectStorage';
import { get, set } from 'idb-keyval';

describe('reference persistence', () => {
  beforeEach(() => { localStorage.clear(); useProjectStore.getState().createProject(); });
  it('flushes the current snapshot to both stores immediately', async () => {
    const project = useProjectStore.getState().project!;
    const track = useProjectStore.getState().addTrack('custom', 'sample');
    const clip = useProjectStore.getState().addClip(track.id, { startTime: 0, duration: 1, prompt: '', lyrics: '' });
    await set('audio:fixture', new NodeBlob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }));
    useProjectStore.getState().updateClipStatus(clip.id, 'ready', { isolatedAudioKey: 'audio:fixture' });
    await flushProjectReferencePersistence(project.id);
    const persisted = JSON.parse(localStorage.getItem('ace-step-daw-project') || 'null');
    expect(persisted.state.project.tracks[0].clips[0].isolatedAudioKey).toBe('audio:fixture');
    expect((await storage.loadProject(project.id))?.tracks[0].clips[0].isolatedAudioKey).toBe('audio:fixture');
    const blob = await get<NodeBlob>('audio:fixture');
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    useProjectStore.setState({ project: null });
    await useProjectStore.persist.rehydrate();
    expect(useProjectStore.getState().project?.tracks[0].clips[0].isolatedAudioKey).toBe('audio:fixture');
  });
  it('rejects a failed library save and a project switch during save', async () => {
    const projectId = useProjectStore.getState().project!.id;
    const save = vi.spyOn(storage, 'saveProject').mockRejectedValueOnce(new Error('disk failure'));
    await expect(flushProjectReferencePersistence(projectId)).rejects.toThrow('disk failure');
    save.mockImplementationOnce(async () => { useProjectStore.getState().createProject(); });
    await expect(flushProjectReferencePersistence(projectId)).rejects.toThrow('Project changed');
    save.mockRestore();
  });
});
