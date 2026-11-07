# Embedded Codex terminal

## User story
As a human user, I want to select Codex inside the DAW assistant, so that I can use my local Codex CLI to inspect and control the current project.

## Behavior
- Given the assistant is closed, opening it SHALL show the selected provider.
- Switching between Claude Code and Codex SHALL preserve each terminal session and scrollback.
- Codex SHALL start with a session-local DAW MCP configuration pointing to the running dev server port; user configuration files MUST NOT be modified.
- The MCP server SHALL accept newline-delimited JSON-RPC and relay tool calls to the browser, returning the browser result to the caller.
- A missing CLI SHALL show installation instructions for the selected provider.
- Closing and reopening the panel SHALL preserve the active provider and session.
- Codex MUST retain its normal authentication, sandbox and approval settings.
- DAW tool calls SHALL return an actionable error when zero or multiple browser tabs are connected.
- Embedded terminals SHALL be available through the Vite development server, matching the existing Claude Code integration.
- Generated audio saved outside the DAW pipeline SHALL be importable through `daw_import_audio` and the `import-audio` CLI command.
- Import SHALL return a ready clip ID, track ID, stored audio key and duration only after decoding, audio storage and waveform creation succeed.
- Missing projects, invalid start positions, missing target tracks and invalid audio SHALL fail without adding an empty track.

## Design
Layout: retain the existing right-hand terminal panel and terminal-owned scrolling. The header provider selector is keyboard accessible. Reuse the existing terminal density and colors.

## Verification
- Test real subprocess initialization and tool discovery with newline-delimited JSON-RPC.
- Test real WebSocket request and response delivery between agent and browser.
- Exercise provider switching, reopening and missing CLI states in browser tests.
- Verify Codex startup and DAW MCP discovery in the real embedded terminal.
