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
5. `logic_export_result` to obtain a result ID/asset metadata. Retrieve that result in the AU, then drag the verified local WAV into a new Logic audio track at the displayed position.

All tools are also available through `npx tsx server/daw-cli.ts logic <tool> '<JSON arguments>'`. A task accepted response is not a completed audio result. Native file drag requires a downloaded local WAV; copy it into the Logic project for portable playback.

## Build and verification

See `plugins/logic-bridge/README.md` for native build and fixture instructions and `server/logic-bridge/README.md` for the exact service contract and operational limitations. The native build does not automatically install a component into the user's system. Installation/rescan and real Logic capture/drag/reopen must be verified separately.

The original [architecture](LOGIC_AU_BRIDGE_DESIGN.md) records the intended behavior and release gates. Current bounded implementation differences are documented in the component READMEs; do not equate deterministic fixture results with a listened-to Base Lego layer.

## Observed development verification limits

The installed AU passed Apple's `auval`, and Logic captured a continuous 12-second, 48 kHz stereo passage at 150 BPM. Base inference on that reference completed independently. A real MCP/browser/service run using that previously generated WAV also reached a ready clip, a ready result and a verified export.

Concurrent inference did not complete the full browser publication path on the 16 GiB test machine while another Turbo backend and Logic were running. Approximately 26 GiB of swap traffic in each direction was measured during one 206-second attempt; the browser stopped responding even though inference completed. This correlation does not establish the precise freeze mechanism. Use a backend with sufficient memory available, and treat simultaneous-inference publication and native result drag/save/reopen as outstanding acceptance checks. A fixture publication pass is not evidence that those checks passed. Do not extend leases or resubmit an unknown task to hide the failure; reconcile its actual backend outcome first.
