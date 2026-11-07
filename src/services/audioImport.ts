import { getAudioEngine } from '../hooks/useAudioEngine';
import { useProjectStore } from '../store/projectStore';
import { audioBufferToWavBlob } from '../utils/wav';
import { computeWaveformWithMipmap } from '../utils/waveformPeaks';
import { saveAudioBlob } from './audioFileManager';

type AudioImportResult = {
  readonly trackId: string;
  readonly clipId: string;
  readonly duration: number;
  readonly audioKey: string;
};

class AudioImportError extends Error {
  override readonly name = 'AudioImportError';
}

export async function importAudioFile(
  file: File,
  startTime = 0,
  trackId?: string,
): Promise<AudioImportResult> {
  const project = useProjectStore.getState().project;
  if (!project) throw new AudioImportError('No project open');
  if (!Number.isFinite(startTime) || startTime < 0 || startTime >= project.totalDuration) {
    throw new RangeError('startTime must be within the project duration');
  }
  if (trackId !== undefined && !project.tracks.some((track) => track.id === trackId)) {
    throw new AudioImportError(`Track not found: ${trackId}`);
  }

  const engine = getAudioEngine();
  const audioBuffer = await engine.ctx.decodeAudioData(await file.arrayBuffer());
  const currentProject = useProjectStore.getState().project;
  if (currentProject?.id !== project.id) {
    throw new AudioImportError('Project changed during audio import');
  }
  if (trackId !== undefined && !currentProject.tracks.some((track) => track.id === trackId)) {
    throw new AudioImportError(`Track not found: ${trackId}`);
  }
  const duration = Math.min(audioBuffer.duration, currentProject.totalDuration - startTime);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('Audio must have a positive duration within the project');
  }

  const trimmedLength = Math.min(Math.floor(duration * audioBuffer.sampleRate), audioBuffer.length);
  const trimmedBuffer = engine.ctx.createBuffer(audioBuffer.numberOfChannels, trimmedLength, audioBuffer.sampleRate);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    trimmedBuffer.getChannelData(channel).set(audioBuffer.getChannelData(channel).subarray(0, trimmedLength));
  }
  const wavBlob = audioBufferToWavBlob(trimmedBuffer);
  const store = useProjectStore.getState();
  const targetTrackId = trackId ?? store.addTrack('custom', 'sample', {
    displayName: file.name.replace(/\.[^.]+$/, ''),
  })?.id;
  if (!targetTrackId) throw new AudioImportError('Unable to create an audio track');
  const clip = store.addClip(targetTrackId, {
    startTime,
    duration,
    prompt: `Imported: ${file.name}`,
    lyrics: '',
  });
  if (!clip) throw new AudioImportError('Unable to create an audio clip');

  const audioKey = await saveAudioBlob(project.id, clip.id, 'isolated', wavBlob);
  const peaks = await computeWaveformWithMipmap(audioKey, trimmedBuffer);
  const completedProject = useProjectStore.getState().project;
  if (completedProject?.id !== project.id) {
    throw new AudioImportError('Project changed during audio import');
  }
  const targetTrack = completedProject.tracks.find((track) => track.id === targetTrackId);
  if (!targetTrack?.clips.some((item) => item.id === clip.id)) {
    throw new AudioImportError('Clip removed during audio import');
  }
  store.updateClipStatus(clip.id, 'ready', {
    isolatedAudioKey: audioKey,
    waveformPeaks: peaks,
    audioDuration: duration,
    audioOffset: 0,
    source: 'uploaded',
  });
  return { trackId: targetTrackId, clipId: clip.id, duration, audioKey };
}
