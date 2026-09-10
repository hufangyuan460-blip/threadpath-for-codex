# Protocol fixtures

These small JSONL files are versioned examples of the app-server messages consumed by the prototype. Request and response lines use the same JSON-RPC ID; notification fixtures have no ID. Unknown response fields are intentional and verify forward-compatible parsing.

When the supported wire protocol changes, update the smallest relevant fixture and its assertions in `src/fixture-tests.ts` together. Keep fixtures representative, redacted, and independent of local thread IDs, authentication, or conversation content. `thread-resume.jsonl` records the verified continuation handshake: `thread/read` reads history, while `thread/resume` activates an existing thread before `turn/start`; `thread-resume-read-only.jsonl` records a thread that must not accept direct input. `process-exit.jsonl` and `timeout.jsonl` describe transport scenarios rather than server messages; the fake app-server integration tests exercise the actual process exit and no-response behavior.
