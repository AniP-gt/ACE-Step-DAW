# ACE-Step Bridge AU

Native AUv2 pass-through effect for Apple Silicon, built with pinned JUCE 8.0.6 under AGPLv3 (the repository licence). JUCE is dual-licensed; distribution outside AGPLv3 requires an appropriate commercial JUCE licence. See https://github.com/juce-framework/JUCE/blob/8.0.6/LICENSE.md and https://github.com/juce-framework/JUCE/blob/8.0.6/docs/CMake%20API.md.

```sh
cmake -S plugins/logic-bridge -B plugins/logic-bridge/build -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Debug
cmake --build plugins/logic-bridge/build -j 4
ctest --test-dir plugins/logic-bridge/build --output-on-failure
```

Build products stay in `build/ACELogicBridge_artefacts/Debug/AU/`; CMake never installs them into Logic. Full Xcode is not required for this development build; Command Line Tools and the macOS SDK are used. Signing, notarization, installation, auval registration and Logic loading are separate release checks.

Start the independent bridge service on `127.0.0.1:5176`. Create a native-role pairing code using its control CLI, enter it in the editor, and choose Pair. Credentials are runtime-only and never saved in AU state; reopening a session requires pairing again. Enter 1–120 seconds, choose Capture, then play a continuous passage in Logic. Host sample position, tempo and meter must be available. Stopping, seeking, looping before the requested duration, format changes or queue overflow fail the take without altering audio. Reported host sample positions may differ from the frame-contiguous expectation by at most one frame, to tolerate timestamp quantization. The first block anchors the timeline; later reported positions never reset that anchor or insert/drop samples. Deviations of two frames or more fail, and tempo/meter checks remain strict.

The render thread only reads host position and copies into a preallocated 262,144-frame SPSC ring. The worker drains into a bounded-duration PCM buffer, then uploads chunks no larger than 1 MiB and finalizes through the service. This implementation deliberately uploads after capture to isolate collection from network stalls. A suspended host triggers an inactivity warning and cancellation; processing must resume to acknowledge cancellation before another take. Captured is shown only after the service returns canonical readiness. The service must be available when uploading; partial network uploads are canceled on failure.

Paste a returned result UUID and choose Fetch result. The worker verifies the asset SHA-256 and WAV decoding before enabling Drag WAV and Reveal in Finder. WAV and JSON placement metadata are saved under `~/Library/Application Support/ACE-Step Bridge/native-results/`. Dragging does not create or position a Logic track automatically.

Development limitations: no result subscription/list yet; manual UUID lookup is required. AU state retains the paired session identifier for display, capture length and last result reference; credentials remain runtime-only. No release or Logic compatibility claim follows from unit tests or a successful local build.
