import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LogicBridgePanel } from '../LogicBridgePanel';
import { useProjectStore } from '../../../store/projectStore';
import { useLogicBridgeStore } from '../../../store/logicBridgeStore';

vi.mock('../../../services/projectStorage', () => ({ saveProject: vi.fn() }));
vi.mock('../../../services/generationPipeline', () => ({ generateFromExplicitContext: vi.fn() }));
vi.mock('../../../services/audioImport', () => ({ importAudioFile: vi.fn() }));

describe('Logic Bridge panel', () => {
  beforeEach(() => {
    useProjectStore.getState().createProject();
    useLogicBridgeStore.setState(useLogicBridgeStore.getInitialState(), true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a rejected pairing and restores the connection control', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'INVALID_PAIRING', message: 'Pairing code invalid or expired', requestId: 'internal-request' } }), { status: 401 }));
    render(<LogicBridgePanel />);
    fireEvent.click(screen.getByText(/Logic Bridge/));
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'expired' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Pairing code invalid or expired'));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(useLogicBridgeStore.getState().connected).toBe(false);
  });

  it('keeps generation disabled until the exact compatible model has been verified', () => {
    const projectId = useProjectStore.getState().project?.id;
    useLogicBridgeStore.setState({ connected: true, selectedCaptureId: 'capture', captures: [{ captureId: 'capture', label: 'Piano', state: 'ready', canonicalFrameCount: 96000, tempo: 120, timeSignature: [4, 4], hostStartSample: 48000, sampleRate: 48000 }], bindings: [{ captureId: 'capture', bindingId: 'binding', projectId }] });
    render(<LogicBridgePanel />);
    fireEvent.click(screen.getByText(/Logic Bridge/));
    expect(screen.getByRole('button', { name: 'Add layer' })).toBeDisabled();
    expect(screen.getByLabelText('End (seconds)')).toHaveValue(2);
  });
});
