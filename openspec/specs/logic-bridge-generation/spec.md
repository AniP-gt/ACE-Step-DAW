# Logic Bridge native generation

## Purpose

A paired native client requests reference preparation and generation through the live DAW executor. The ordinary job pipeline remains the sole generation pipeline.

## Requirements

### Session ownership and preparation

The service MUST scope native receipts to the exact native credential and session. A native credential has no project authority, MUST NOT provide a project or job ID to select work, and MUST NOT gain generic job read or mutation privileges. Private credential hashes, tokens, internal request IDs and filesystem paths MUST NOT appear in public receipts or saved native plugin state.

#### Scenario: Pin the live executor project

- Given a ready canonical capture owned by the native session and a live executor
- When the native owner requests preparation
- Then the service pins the executor's current project in a durable receipt, even if the executor later switches projects
- And preparation is allowed without a verified model

#### Scenario: Confirm a persisted binding

- Given a pending preparation pinned to a project
- When its current, matching live executor imports the canonical capture, persists the clip and audio, and acknowledges the matching binding
- Then the receipt becomes prepared and identifies that binding
- And a different project, stale lease, missing persistence or mismatched binding MUST NOT confirm it

#### Scenario: Retain the previous reference

- Given a confirmed reference
- When a replacement capture or preparation fails
- Then the previous confirmed reference remains visibly identified and is not silently replaced

### Idempotent, durable intents

#### Scenario: Repeat an accepted request

- Given a receipt saved for an owner, request ID and immutable payload
- When the same owner retries that ID and payload, including after a lost response or restart
- Then the service returns the original receipt before evaluating current readiness and creates no duplicate work
- And a different payload with the same owner and ID receives a conflict

#### Scenario: Restrict old receipts after re-pairing

- Given a receipt created with one native credential
- When a different credential or re-paired native client reads or cancels it
- Then the service denies access, and does not automatically resubmit the old request
- And unknown or occupied work requires reconciliation through the DAW

### Fresh validation and submission

#### Scenario: Submit only after executor validation

- Given a generation intent naming the displayed prepared receipt
- When the matching current executor freshly validates the clip and its source, verified loaded model, supported instrument and current capability
- Then its acknowledgement atomically creates one ordinary job and links it to the durable intent using a server-generated internal job request ID
- And no ordinary job or inference starts before that acknowledgement
- And a caller-supplied native request ID MUST NOT be used for generic job lookup or deduplication

#### Scenario: Reject stale context

- Given a prepared reference or pending intent
- When the project switches, its clip is removed or changed, the lease expires, or the model becomes unavailable or incompatible
- Then submission is disabled or the intent fails without creating a job
- And stale acknowledgement cannot submit to another project

#### Scenario: Refresh capability while paired

- Given an existing pairing
- When the executor's model inventory or supported instruments change
- Then the executor refreshes its registered capabilities and the native client updates readiness without re-pairing
- And a fresh validation acknowledgement is still required before job creation

#### Scenario: Validate the prompt and range

- Given a ready prepared reference and a supported instrument
- When the user submits an empty or whitespace-only prompt
- Then the existing default instruction is used
- And the complete canonical capture is the generation range
- When the prompt exceeds 4096 UTF-16 code units
- Then the request is rejected without truncation or job creation

### Cancellation and uncertainty

#### Scenario: Cancel before dispatch

- Given the native owner's undispatched queued job
- When the owner cancels its linked request
- Then the queued job is canceled and reserved occupancy is released

#### Scenario: Preserve uncertain backend occupancy

- Given an accepted submission whose backend outcome is unknown or may still be running
- When cancellation, a lost response, restart or a native UI reset occurs
- Then the service retains unknown occupancy until authoritative reconciliation
- And the UI MUST NOT claim inference stopped or automatically retry
- And the client records its request ID before network submission

### Results and interaction

#### Scenario: Explicitly fetch a published result

- Given a newly published ready result and a previously fetched WAV
- When the results catalog is updated
- Then the client shows a notice without automatically selecting, downloading or replacing the current WAV
- And the user can select and explicitly fetch a result

#### Scenario: Keyboard access at supported sizes

- Given an editor at 440×360, 640×520 or 880×720
- When a user navigates with the keyboard
- Then every capture, generation and result control is reachable with visible focus
- And the workflow scrolls as needed while the header and output footer remain visible
- And connection, capture, generation and output states are distinguishable without invented progress percentages
