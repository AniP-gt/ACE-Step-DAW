# Logic Bridge Direct Cover

## Purpose

A paired native client requests a Cover transformation of captured audio without an ACE-Step DAW executor. The bridge service sends the source and prompt to a separately running ACE-Step API and publishes the validated audio as a session result.

## Requirements

### Native operation

- Given a paired AU with a ready audio capture and a nonblank prompt of at most 4096 UTF-16 code units, the user can select Direct Cover and submit one generation.
- The capture contains the audio reaching the AU insert, not MIDI events. The output is a transformed source and MUST NOT be represented as note-exact MIDI rendering or as a Lego isolated layer.
- The AU displays the captured source and generation state. On ready it fetches the result; only a verified local WAV can be dragged. If automatic fetch fails, the existing session result catalog permits explicit fetch.
- The source used by a direct request is the successful capture identified at submission. The existing DAW capture, executor and results workflow remains available.

### Durable submission and occupancy

- Given a native credential, session and client request ID, a repeated identical request returns the same receipt. A request with conflicting capture or prompt MUST fail without starting another generation.
- Direct and DAW jobs share bridge occupancy. Existing DAW jobs retain project binding and executor checks; a native direct request cannot create an ordinary DAW job or supply arbitrary output paths.
- If submission is uncertain, the bridge MUST retain unknown occupancy and MUST NOT automatically submit the request again. A known backend task MUST be checked by its task ID after transient status-query failures, using bounded backoff, and may be checked after service restart. A completed known task whose result download has a transient network, HTTP 408, 429, or 5xx failure MUST remain recoverable by rechecking the same task, without resubmitting inference. An outer failure status without confirmed inner terminal failure MUST retain unknown occupancy. A queue-full HTTP 429 with the exact maintained API detail is a pre-enqueue rejection and may release occupancy. The bridge MUST NOT resubmit inference.
- An interrupted unknown job may be released by the installation control credential after the operator has independently confirmed that the backend stopped. This action MUST NOT claim to stop inference. Released interrupted requests, including unsubmitted requests recovered after restart, MUST expose a failed receipt; replaying the old request ID MUST return that receipt and late polling MUST NOT publish a result.

### Output

- The worker requests one instrumental Cover based on the captured audio, validates its returned WAV, canonicalizes it to 48 kHz stereo float32, and publishes the actual frame count and capture start position.
- A result that violates input-format, duration, size, or integrity checks MUST NOT become ready. Cover output MUST NOT be silently cropped to satisfy the separate Lego source-range contract.
- Successful fixture, API, and Logic-host checks establish only their observed surfaces; musical quality and source fidelity require separate listening.
