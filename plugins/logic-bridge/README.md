# ACE-Step Bridge AU

Native AUv2 pass-through effect for Apple Silicon, built with pinned JUCE 8.0.6 under AGPLv3 (the repository licence). JUCE is dual-licensed; distribution outside AGPLv3 requires an appropriate commercial JUCE licence. See https://github.com/juce-framework/JUCE/blob/8.0.6/LICENSE.md and https://github.com/juce-framework/JUCE/blob/8.0.6/docs/CMake%20API.md.

```sh
cmake -S plugins/logic-bridge -B plugins/logic-bridge/build -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Debug
cmake --build plugins/logic-bridge/build -j 2
ctest --test-dir plugins/logic-bridge/build --output-on-failure
```

Build products stay in `build/ACELogicBridge_artefacts/Debug/AU/`; CMake never installs them into Logic. Full Xcode is not required for this development build; Command Line Tools and the macOS SDK are used. Signing, notarization, installation, auval registration and Logic loading are separate release checks.

Start the independent bridge service on `127.0.0.1:5176`. Create a native-role pairing code using its control CLI, enter it in the editor, and choose Pair. Credentials are runtime-only and never saved in AU state; reopening a session requires pairing again. Enter 1–120 seconds, choose Capture, then play a continuous passage in Logic. Host sample position, tempo and meter must be available. Stopping, seeking, looping before the requested duration, format changes or queue overflow fail the take without altering audio. Reported host sample positions may differ from the frame-contiguous expectation by at most one frame, to tolerate timestamp quantization. The first block anchors the timeline; later reported positions never reset that anchor or insert/drop samples. Deviations of two frames or more fail, and tempo/meter checks remain strict.

## ACE-Step DAW isolated-layer generation

Start the bridge and open the intended ACE-Step DAW project. Pair its executor to the same bridge session, and load a verified non-Turbo LEGO model that advertises isolated-layer output. Pair the AU using a native code for that session. Connection alone does not mean the executor or model is ready.

1. Choose **ACE-Step DAW**, set 1–120 seconds, select **Capture**, and play the passage continuously. After canonical capture is ready, the AU automatically requests reference preparation. The executor imports the capture into the paired project and durably acknowledges its binding; wait for readiness before generating. When a replacement preparation is accepted but pending, failed, or canceled, the old reference may remain displayed but cannot be generated from. If its POST is rejected before acceptance, fresh authoritative readiness can permit explicit generation from the displayed prior reference.
2. Choose a supported instrument and enter an optional prompt of at most 4096 UTF-16 code units. Empty or whitespace-only text uses `Add an instrumental layer`. Choose **Generate**. The full capture is the generation range.
3. When the result appears in Results, select it and choose **Fetch selected**. Selection alone does not change Current WAV. Explicit Fetch clears the active export while it downloads; a failed fetch leaves export actions unavailable. After verification, place the WAV manually in Logic at the signed **Suggested start**, shown in seconds to six decimal places.

The AU sends scoped preparation and generation requests; it does not receive generic permission to write jobs. Cancellation prevents publication but does not prove backend inference has stopped. A lost response or unknown backend outcome is not automatically retried; reconcile it as described in the service README. Re-pairing does not automatically retry an unknown request. A previously verified cached WAV can be restored offline independently of pairing.

## Direct Cover generation

Direct Cover sends the captured **audio** to a separately running ACE-Step API through the local bridge service. It does not require an open ACE-Step DAW project. Start the bridge and an ACE-Step API with a loaded Cover-capable model. Run `npm run bridge:pair -- --native-only 'Logic session'` and enter the resulting one-use native code in the AU within 120 seconds. Save the printed session ID; to pair again with that session, use `npm run bridge:pair -- --native-session '<session-id>'`. See [Logic Bridge Development Usage](../../docs/design/LOGIC_BRIDGE_USAGE.md) for setup and pairing.

1. Insert the AU after a software instrument or on an audio track. Set the capture duration, choose **Capture**, and play the passage continuously in Logic. The source label identifies the last successfully captured audio and its duration.
2. Choose **Direct Cover**, enter a nonblank prompt of at most 4096 UTF-16 code units, and choose **Generate Cover**. For example, describe a solo violin and the desired articulation. Generation uses one instrumental Cover with source influence set to 1.0.
3. Wait for the generation and WAV fetch to complete. The verified file becomes available through **Drag WAV** and **Reveal in Finder**. Place it in Logic at the displayed **Suggested start**. If generation finishes but automatic download fails, select its entry in Results and choose **Fetch selected**.

The AU captures the rendered instrument output, not MIDI events. ACE-Step may alter notes, note lengths, timing, and musical details; neither the generated instrument nor note-for-note fidelity is guaranteed. **ACE-Step DAW** is the separate isolated-layer mode described above.

Closing only the editor does not cancel a submitted request or replace the processor. Communication interruptions can leave an outcome unknown; while an active receipt is available, the AU checks the existing request rather than submitting it again. A new credential cannot access the previous credential's private receipt.

For **ACE-Step DAW**, restoring state or re-pairing clears the active request snapshot while conservatively retaining an unknown status. If that snapshot is lost, first have the DAW operator confirm and reconcile pending or unknown work under the [service rules](../../server/logic-bridge/README.md#native-daw-generation-requests). Then save, close and reopen the Logic project, or reinstantiate the AU, to create a fresh processor and pair again. Closing and reopening only the editor retains the processor and cannot clear that state.

For **Direct Cover**, restoring state or re-pairing clears the local request and captured source state. This does not establish that backend occupancy was released or computation stopped. Before an explicit new request, confirm and reconcile the backend according to the [Direct Cover service rules](../../server/logic-bridge/README.md#direct-cover-jobs); this does not require a DAW executor. Neither mode automatically submits or retries a generation. A verified saved WAV can restore offline independently of pairing.

The render thread only reads host position and copies into a preallocated 262,144-frame SPSC ring. The worker drains into a bounded-duration PCM buffer, then uploads chunks no larger than 1 MiB and finalizes through the service. This implementation deliberately uploads after capture to isolate collection from network stalls. A suspended host triggers an inactivity warning and cancellation; processing must resume to acknowledge cancellation before another take. Captured is shown only after the service returns canonical readiness. The service must be available when uploading; partial network uploads are canceled on failure.

The Results list shows ready results for the paired session, with instrument, duration, signed suggested start and a shortened UUID. The full UUID is available to accessibility tools. Select a row and choose **Fetch selected**; selection and refresh alone do not download a result or replace the current cached WAV. Use **Refresh** to check for new results, **Older** to page backward, and **Latest** to return to the newest page. The current selection is retained across refresh and page changes; Fetch is available when that result is present on the displayed page. Open **Advanced** to enter a result UUID and choose **Fetch UUID** when manual lookup is needed. The editor defaults to 640×520 and can resize from 440×360 to 880×720. The middle workflow scrolls while the Current WAV footer stays visible; **Connection** and **Advanced** open their respective disclosures.

The list polls only while the editor is visible and paired. The metadata worker uses background QoS on macOS, independently of the audio and capture workers. The first successful latest-page response establishes a silent baseline. Later results above the session's recorded high-water mark show the persistent generic **New results available** notice; **Dismiss** clears it. The notice does not show a count, and an unchanged list or re-pairing to the same session does not produce another notice. A restored AU state or a different session establishes a new baseline. Background latest-page checks do not replace an older page being browsed. A failed check retains the displayed rows and marks them stale; automatic retries back off up to 30 seconds. Re-pair when reopening because credentials are runtime-only.

Fetch verifies the asset SHA-256 and WAV decoding before enabling Drag WAV and Reveal in Finder. Verified original WAV bytes and metadata are stored privately under `~/Library/ACE-Step Bridge/native-results/verified-cache/`. Drag WAV and Reveal in Finder expose a separate writable WAV and sidecar under `~/Library/ACE-Step Bridge/native-results/`, so Logic can append metadata without altering the verified original. The read-only Suggested start label shows the signed placement in seconds to six decimal places. Drag the WAV to that position in Logic; dragging does not create or position a Logic track automatically. Missing or nonfinite/nonnumeric placement metadata is rejected during download and cache restoration.

AU state retains the paired session identifier for display, capture length, last result reference, `cacheVersion: 1` and a safe private-cache WAV basename; credentials remain runtime-only. On every reopen the background worker verifies the private original WAV and matching sidecar without network access, then creates a fresh writable export before enabling Drag WAV and Reveal in Finder. Previously handed-out copies are never overwritten or deleted; Logic project references remain valid. A state without `cacheVersion` is legacy version 0: its old cache must pass the original strict byte hash and metadata checks before migration into the private cache. If Logic already changed that legacy file, re-pair and fetch again; matching decoded audio does not bypass the integrity check. Missing or corrupt private originals also require re-pair/refetch. No release or Logic compatibility claim follows from unit tests or a successful local build.

### Logic-host workflow check

On 2026-11-16 the installed AU was exercised in Logic through pairing, capture, durable reference preparation, keyboard instrument and multiline prompt entry, one generation submission, explicit result Fetch, Reveal, Logic audio import, playback, save and reopen. Offline restoration produced a fresh export with credentials reset. This used a deterministic model fixture, not inference; exact negative placement, native drag, VoiceOver, OS hover and Logic-host resizing were not tested. See the [workflow record and actual host screenshots](../../docs/design/LOGIC_BRIDGE_PLUGIN_WORKFLOW.md#observed-logic-host-workflow-2026-11-16) for scope and evidence.

### Result catalog fixture

With port 5176 free, run the actual processor and editor against a test-owned loopback fixture. The fixture does not start model inference and removes only the WAV and sidecar pairs it creates for its own result UUID.

```sh
python3 plugins/logic-bridge/tests/result_catalog_probe.py plugins/logic-bridge/build/processor_probe_artefacts/Debug/processor_probe --ui /absolute/path/to/screenshot-directory
```

The fixture covers explicit keyboard Fetch, verified WAV retrieval, page navigation, polling while browsing older results, same-session re-pairing, notification dismissal and cache/placement preservation. It renders editor states at 440×360 and 880×720; it does not establish Logic-host compatibility.

### Native cache race regression

Stop the development bridge service through its owner before running the following tests; the fixture requires exclusive loopback port 5176 and never terminates existing processes. Restart the service afterward.

```sh
python3 plugins/logic-bridge/tests/cache_race_probe.py plugins/logic-bridge/build/processor_probe_artefacts/Debug/processor_probe
python3 plugins/logic-bridge/tests/cache_race_probe.py plugins/logic-bridge/build/processor_probe_artefacts/Debug/processor_probe --pair-race
```

The fixture delays a real HTTP result or pairing response, restores another cached AU state before releasing it, and verifies that the late response cannot replace the restored selection or credentials. Loading host state clears runtime credentials on the worker and requires explicit re-pairing for subsequent captures. Cached files remain available offline.

### Slow canonicalization response regression

JUCE maps its connection timeout option to macOS request idle timeout. Capture finalization allows 30 seconds without response activity for offline canonical conversion; other requests retain 3 seconds. This does not change the audio render thread. With the real bridge service stopped by its owner, run:

```sh
python3 plugins/logic-bridge/tests/finalize_timeout_probe.py plugins/logic-bridge/build/processor_probe_artefacts/Debug/processor_probe
```

The loopback fixture receives an actual 1-second native capture and delays the finalize response by 8 seconds. It never starts model inference or stops an existing service. Restart the real service after the fixture exits.

### Writable export isolation regression

The native processor probe migrates a test-owned legacy WAV, appends a valid RIFF JUNK metadata chunk to its writable export, and reopens the saved state in a new processor without networking. It verifies exact decoded audio, an unchanged private-cache hash, a fresh export with original bytes, and preservation of the modified prior export. The probe cleans only its exact test-owned files. These cases run in the normal CTest processor test. Actual downloaded results used by `--fetch-result` are retained, and the receipt prints distinct canonical/export/reopened-export paths.
