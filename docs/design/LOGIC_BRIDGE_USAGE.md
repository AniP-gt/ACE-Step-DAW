# Logic Bridge Development Usage

This development integration captures audio from a native AU effect and supplies an explicitly selected source to the separate DAW. Model generation requires a verified compatible Base model. Building the plugin alone does not establish Logic compatibility or musical output quality.

## Start the service and DAW

```sh
npm run bridge
npm run dev
```

The service listens at `http://127.0.0.1:5176/v1`. Its private data defaults to `~/Library/Application Support/ACE-Step Bridge`. `LOGIC_BRIDGE_ROOT` and `LOGIC_BRIDGE_PORT` override service storage/port. The current native AU and browser client expect port 5176; use the default for their integration.

Open an empty DAW project and obtain its project ID through the existing `daw_get_project`/project store interface as supported by the build. Pair explicitly with that project:

```sh
npm run bridge:pair -- 'Logic session' '<DAW-project-id>' '/absolute/private/path/mcp-credential.json'
```

The output contains a session ID and short-lived native/executor pairing codes. Enter the native code in the AU and the executor code in the DAW Logic Bridge panel within 120 seconds. The MCP credential is written to the requested new file with owner-only permissions; tokens are not printed. The destination parent must already exist. Existing credential files are never overwritten.

For MCP/CLI service tools, set `LOGIC_BRIDGE_CREDENTIAL_FILE` to that explicit credential file in the environment launching the MCP process. Alternatively supply `LOGIC_BRIDGE_TOKEN` and `LOGIC_BRIDGE_SESSION_ID`. Do not paste tokens into prompts or checked-in configuration. The project/session binding is validated before mutation; a different open tab is never selected implicitly.

The embedded Codex launcher forwards the names `LOGIC_BRIDGE_URL`, `LOGIC_BRIDGE_TOKEN`, `LOGIC_BRIDGE_SESSION_ID` and `LOGIC_BRIDGE_CREDENTIAL_FILE` to its session-local MCP configuration. Start the DAW with the intended environment before opening that terminal. Secret values are not added to command-line configuration.

## Capture and add a layer

Insert the AU after the existing software instrument, or on an audio track/bus. Choose capture seconds, arm it while stopped, then play a continuous passage. The original signal passes through. Stop/seek/loop discontinuities invalidate incomplete captures. In the DAW panel, select a ready capture and use it as context. A first reference requires an empty bridge project.

Generation is disabled unless a compatible loaded model matches the explicit `VITE_LOGIC_BRIDGE_VERIFIED_MODEL` development launch setting. This setting is a local enablement mechanism after actual output verification, not evidence by itself. Do not label an arbitrary model verified merely to enable the button.

Captured tempo and meter are used for the explicit reference. The AU does not supply a musical key; explicit-context generation requests automatic key detection rather than inheriting a new project's default key.

Tool flow:

1. `logic_list_captures` with session ID.
2. `daw_attach_logic_capture` with session/project/capture/client-request IDs.
3. `daw_add_layer_from_context` with the returned binding, model, instrument and canonical frame range.
4. `logic_get_job` until actual `ready` or a terminal error.
5. `logic_export_result` to obtain a result ID/asset metadata. In the paired AU, select the ready result and choose **Fetch selected**, then drag the verified local WAV into a new Logic audio track at the displayed position.

All tools are also available through `npx tsx server/daw-cli.ts logic <tool> '<JSON arguments>'`. A task accepted response is not a completed audio result. Native file drag requires a downloaded local WAV; copy it into the Logic project for portable playback.

For keyboard-based return, create a new Logic audio track, use File > Import > Audio File, and select the exported WAV shown by Reveal in Finder. Import it at the suggested position. File > Project Management > Consolidate with audio-file copying enabled makes the project independent from the bridge's export folder. Logic can append metadata to an imported WAV; the current native implementation therefore keeps its verified original separately in `~/Library/ACE-Step Bridge/native-results/verified-cache/` and hands out writable copies. Offline restoration validates the original and makes a fresh copy without overwriting earlier exported files.

The AU Results list shows the paired session's ready results with instrument, duration, signed start and a shortened UUID. Select a row and choose **Fetch selected**. Selection, refresh and paging do not fetch audio or replace a previously downloaded WAV. Use **Refresh** for a new check, **Older** for the next older page and **Latest** to return to the newest page; a selected ID remains selected across navigation and can be fetched when visible again. The full UUID is available to accessibility tools. For manual lookup, open **Advanced**, enter a result UUID and choose **Fetch UUID**. The DAW Logic Bridge panel also exposes a selectable read-only `Result UUID`, and MCP `logic_export_result` is another way to obtain it.

While the AU editor is visible and paired, it polls for results using a separate background worker. On macOS that worker uses background QoS. The first successful latest-page response is a silent baseline; a later result above the session high-water mark shows **New results available** until dismissed. It is a generic notice without a count. An unchanged result set or re-pairing to the same session does not repeat the notice; a restored AU state or a different session starts a new baseline. Background checks do not replace an older page. Failed checks retain the displayed rows, show a stale state and back off automatic retries up to 30 seconds. Pair again after reopening because credentials are not saved. Explicit-context source uploads preserve canonical WAV bytes instead of applying the ordinary upload downsampling optimization.

## Build and verification

See `plugins/logic-bridge/README.md` for native build and fixture instructions and `server/logic-bridge/README.md` for the exact service contract and operational limitations. The native build does not automatically install a component into the user's system. Installation/rescan and real Logic capture/drag/reopen must be verified separately.

The original [architecture](LOGIC_AU_BRIDGE_DESIGN.md) records the intended behavior and release gates. Current bounded implementation differences are documented in the component READMEs; do not equate deterministic fixture results with a listened-to Base Lego layer.

## Observed development verification limits

The observations below concern earlier installed builds. The result catalog has passed native editor and loopback fixtures. The repair7 AU was installed and passed Apple's `auval`, and Logic was restarted, but the new catalog workflow has not been verified in Logic because GUI access was blocked. The existing Logic project was preserved and a backup of the previous AU is available.

The installed AU passed Apple's `auval`, and Logic captured a continuous 12-second, 48 kHz stereo passage at 150 BPM. Base inference on that reference completed independently. A real MCP/browser/service run using that previously generated WAV also reached a ready clip, a ready result and a verified export.

Actual Logic AU download, file-menu import at zero seconds, copying into project assets, save/reopen and playback with generation services stopped have been observed. The copied audio contains exactly the original 575,569 stereo frames at 48 kHz, despite Logic changing container metadata. The final immutable-cache correction is installed and restores results in actual Logic without the service. The user also placed an exported WAV by dragging and moved it to zero seconds; automated AU cross-window dragging remains unverified.

A subsequent real MCP/browser/Base run completed generation, ready timeline publication and export, followed by AU retrieval and Logic file-menu import, asset copying, save/reopen and service-independent playback. The tested source was 12 seconds at 150 BPM, batch size 1 and 32 inference steps. The user-authorized ACE-Step-1.5 backend correction adds opt-in `ACESTEP_MPS_LOW_MEMORY=true`: MPS DiT/text BF16 loading and disabled duplicate MLX backends. Start a fresh backend process with that flag, keep LM disabled and verify Base is actually loaded before pairing the executor. Logic was saved and closed during this run's model inference, then reopened for return; simultaneous Logic/model inference and larger workloads remain unverified. Musical quality was not rated. Evidence: `.omo/evidence/logic-bridge-actual-low-memory/`.

Concurrent inference did not complete the full browser publication path on the 16 GiB test machine while another Turbo backend and Logic were running. Approximately 26 GiB of swap traffic in each direction was measured during one 206-second attempt; the browser stopped responding even though inference completed. This correlation does not establish the precise freeze mechanism. A later guarded Base-only eager startup was stopped after swap activity rose; no inference was submitted. A lazy Base API can start without loading its model, but a successful health response does not establish generation readiness or lower the model's eventual memory requirement. Use a backend with sufficient memory available. A fixture publication pass is not evidence of real-inference publication. Explicit-context submissions are not automatically retried after an uncertain response; reconcile their actual backend outcome before retrying.
