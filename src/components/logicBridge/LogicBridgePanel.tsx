import { useEffect, useState } from 'react';
import { useLogicBridgeStore } from '../../store/logicBridgeStore';
import { useProjectStore } from '../../store/projectStore';
import { useGenerationStore } from '../../store/generationStore';
import { TRACK_NAMES } from '../../constants/tracks';
import { addLayerFromLogicContext, attachLogicCapture, connectBridge, disconnectBridge, refreshBridge } from '../../services/logicBridge';
import { bridgeJson, canonicalBlob, numberField, stringField } from '../../services/logicBridgeClient';

const control = 'min-h-8 rounded bg-daw-surface-2 px-2 py-1 text-sm text-zinc-200 hover:bg-daw-hover active:bg-daw-surface-3 focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50';

export function LogicBridgePanel() {
  const state = useLogicBridgeStore();
  const projectId = useProjectStore(s => s.project?.id);
  const backendOccupied = useGenerationStore(s => s.backendOccupancyJobId !== null);
  const [code, setCode] = useState('');
  const [instrument, setInstrument] = useState('bass');
  const [prompt, setPrompt] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const capture = state.captures.find(item => item.captureId === state.selectedCaptureId);
  const binding = state.bindings.find(item => item.captureId === state.selectedCaptureId && item.projectId === projectId);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { setStart(0); setEnd(capture ? numberField(capture, 'canonicalFrameCount') / 48000 : 0); setPreview(null); }, [capture?.captureId]);

  async function perform(action: () => Promise<unknown>) {
    useLogicBridgeStore.setState({ pending: true, error: null });
    try { await action(); }
    catch (error) { useLogicBridgeStore.setState({ error: error instanceof Error ? error.message : 'Bridge operation failed' }); }
    finally { useLogicBridgeStore.setState({ pending: false }); }
  }

  return <details className="shrink-0 border-b border-daw-border bg-daw-surface text-zinc-200">
    <summary className="min-h-8 cursor-pointer px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-daw-accent">Logic Bridge · {state.connected ? 'Connected' : 'Disconnected'}</summary>
    <div className="max-h-[50vh] space-y-3 overflow-auto p-3">
      {!state.connected ? <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void perform(() => connectBridge(code)); }}>
        <label className="flex w-full flex-col gap-1 text-sm">Project ID for pairing<input className={`${control} w-full max-w-md`} readOnly value={projectId ?? ''} onFocus={event => event.currentTarget.select()} /></label>
        <label className="flex flex-col gap-1 text-sm">Pairing code<input className={control} value={code} onChange={event => setCode(event.target.value)} autoComplete="off" required /></label>
        <button className={control} disabled={state.pending || !projectId}>Connect</button>
        <span className="text-sm">Open an empty project and pair it with the local bridge.</span>
      </form> : <>
        <div className="flex flex-wrap gap-2">
          <button className={control} disabled={state.pending} onClick={() => void perform(refreshBridge)}>Refresh sources</button>
          <button className={control} onClick={disconnectBridge}>Disconnect</button>
          <span className="self-center text-sm">{state.verifiedModelId ? `Layer model: ${state.verifiedModelId}` : 'Compatible layer model not verified'}</span>
        </div>
        {state.captures.length === 0 && <p className="text-sm">No captures yet. Capture a passage in Logic, then refresh sources.</p>}
        <ul className="space-y-2">{state.captures.map(item => <li key={stringField(item, 'captureId')} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{stringField(item, 'label')} · {String(item.state)} · {Number(item.canonicalFrameCount ?? 0) / 48000}s · {String(item.tempo)} BPM · {Array.isArray(item.timeSignature) ? item.timeSignature.join('/') : 'Meter unavailable'} · Position {(numberField(item, 'hostStartSample') / numberField(item, 'sampleRate')).toFixed(3)}s</span>
          <button className={control} disabled={state.pending || item.state !== 'ready'} onClick={() => void perform(() => attachLogicCapture({ sessionId: state.sessionId, projectId, captureId: item.captureId, clientRequestId: crypto.randomUUID() }))}>Use as context</button>
        </li>)}</ul>
        {capture && binding && <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
          event.preventDefault();
          void perform(() => addLayerFromLogicContext({ sessionId: state.sessionId, projectId, captureId: capture.captureId, bindingId: binding.bindingId, clientRequestId: crypto.randomUUID(), instrument, startFrame: Math.round(start * 48000), endFrame: Math.round(end * 48000), prompt, modelId: state.verifiedModelId, seed: -1 }));
        }}>
          <span className="w-full text-sm">Reference: {stringField(capture, 'label')}</span>
          <button type="button" className={control} disabled={state.pending} onClick={() => void perform(async () => { if (state.token) setPreview(URL.createObjectURL(await canonicalBlob(state.token, capture))); })}>Preview reference</button>
          {preview && <audio controls src={preview} className="max-w-full" aria-label="Canonical Logic reference" />}
          <label className="flex flex-col gap-1 text-sm">Instrument<select className={control} value={instrument} onChange={event => setInstrument(event.target.value)}>{TRACK_NAMES.map(name => <option key={name}>{name}</option>)}</select></label>
          <label className="flex flex-col gap-1 text-sm">Start (seconds)<input className={`${control} w-28`} type="number" min="0" step="any" value={start} onChange={event => setStart(Number(event.target.value))} /></label>
          <label className="flex flex-col gap-1 text-sm">End (seconds)<input className={`${control} w-28`} type="number" min="0" step="any" value={end} onChange={event => setEnd(Number(event.target.value))} /></label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">Prompt<input className={control} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
          <button className={`${control} font-semibold`} disabled={state.pending || !state.verifiedModelId}>Add layer</button>
        </form>}
        <ul className="space-y-2">{state.jobs.map(job => <li key={stringField(job, 'jobId')} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{stringField(job, 'instrument')} · {stringField(job, 'state')}</span>
          {job.state === 'ready' && typeof job.resultId === 'string' && job.resultId && <div className="w-full min-w-0 space-y-1">
            <label className="flex flex-col gap-1">Result UUID<input className={`${control} w-full max-w-md font-mono`} readOnly value={job.resultId} onFocus={event => event.currentTarget.select()} /></label>
            <p>Copy this UUID into Result UUID in the Logic Bridge AU, then click Fetch result.</p>
          </div>}
          {['queued', 'dispatched', 'running', 'exporting'].includes(String(job.state)) && <button className={control} onClick={() => void perform(async () => { if (state.token) await bridgeJson(state.token, `/jobs/${encodeURIComponent(stringField(job, 'jobId'))}/cancel`, {}); })}>Cancel layer</button>}
        </li>)}</ul>
      </>}
      {state.pending && <p role="status" className="text-sm">Working…</p>}
      {!state.connected && backendOccupied && <p role="status" className="text-sm">Previous backend generation needs reconciliation. Reconnect its bridge session before generating again.</p>}
      {state.error && <p role="alert" className="break-words text-sm">{state.error}</p>}
    </div>
  </details>;
}
