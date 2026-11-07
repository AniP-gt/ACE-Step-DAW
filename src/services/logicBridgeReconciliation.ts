import { useGenerationStore } from '../store/generationStore';
import { useLogicBridgeStore } from '../store/logicBridgeStore';
import { queryResult } from './aceStepApi';
import { bridgeJson, stringField, type BridgeObject } from './logicBridgeClient';

export async function reconcileBridgeJob(job: BridgeObject, token: string): Promise<void> {
  const jobId = stringField(job, 'jobId');
  if (job.backendOccupancy === 'released') {
    if (useGenerationStore.getState().backendOccupancyJobId === jobId) {
      useGenerationStore.setState({ backendOccupancyJobId: null });
      useLogicBridgeStore.setState({ error: null });
    }
    return;
  }
  useGenerationStore.setState({ backendOccupancyJobId: jobId });
  if (typeof job.backendTaskId !== 'string' || !job.backendTaskId) {
    useLogicBridgeStore.setState({ error: 'Backend submission status is unknown. Reconcile the backend before generating again.' });
    return;
  }
  useLogicBridgeStore.setState({ error: 'Waiting for the previous backend generation to finish.' });
  const entries = await queryResult([job.backendTaskId], { signal: AbortSignal.timeout(15000) });
  const entry = entries.find(item => item.task_id === job.backendTaskId);
  if (!entry || (entry.status !== 1 && entry.status !== 2)) return;
  const reconciled = await bridgeJson(token, `/jobs/${encodeURIComponent(jobId)}/reconcile`, {
    backendTaskId: job.backendTaskId,
    outcome: entry.status === 1 ? 'completed' : 'failed',
  });
  if (reconciled.backendOccupancy !== 'released') return;
  useLogicBridgeStore.setState(state => ({ error: null, jobs: [...state.jobs.filter(item => item.jobId !== jobId), reconciled] }));
  if (useGenerationStore.getState().backendOccupancyJobId === jobId) useGenerationStore.setState({ backendOccupancyJobId: null });
}
