import { create } from 'zustand';
import type { BridgeObject } from '../services/logicBridgeClient';

interface LogicBridgeState {
  token: string | null;
  sessionId: string | null;
  projectId: string | null;
  captures: BridgeObject[];
  bindings: BridgeObject[];
  jobs: BridgeObject[];
  selectedCaptureId: string | null;
  error: string | null;
  pending: boolean;
  connected: boolean;
  verifiedModelId: string | null;
  executorId: string | null;
}

// Credentials intentionally remain in memory, never in project files or localStorage.
export const useLogicBridgeStore = create<LogicBridgeState>(() => ({
  token: null, sessionId: null, projectId: null, captures: [], bindings: [], jobs: [],
  selectedCaptureId: null, error: null, pending: false, connected: false, verifiedModelId: null, executorId: null,
}));
