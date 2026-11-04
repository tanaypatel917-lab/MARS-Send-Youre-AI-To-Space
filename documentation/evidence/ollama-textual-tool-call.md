# Ollama trace: tool call returned as assistant text

Scope: the live `qwen3-coder:30b` run recorded in `local-model-run.txt`
(2026-11-03, CPU-only Ollama, real Oh My Pi runtime session, `model_requests: 1`).
The run ended `status: "completed"` and the requested file was never written.

## What was recorded (raw, from `local-model-run.txt`)

- Request: `scripts/local-model-run.ts ollama/qwen3-coder` — "create a file named
  greet.txt with the content Hello"; write approval only; cwd
  `/tmp/mars-local-run-c7Ii6Q`.
- Expected file: `/tmp/mars-local-run-c7Ii6Q/greet.txt` (recorded as
  `greet_txt: null` — absent).
- Final assistant text, verbatim:

```
I'll create a file named greet.txt with the content "Hello".

<function=mars_write>
<parameter=path>
greet.txt
</parameter>
<parameter=content>
Hello
</parameter>
<parameter=i>
Create greet.txt with Hello text
</parameter>
</function>
</tool_call>
```

- Direct replay of the dumped request body against Ollama (`stream=false`,
  `temperature=0`): `finish_reason: "stop"`, no `tool_calls`, the text above in
  `content`. The same request without the MARS system prompt returned
  `finish_reason: "tool_calls"` with a structured `mars_write` call.

## What is proved offline (this PR)

`packages/providers/src/models/ollama-trace.test.ts` replays both shapes through
`createOpenAICompatibleAdapter`, the adapter the execution runtime uses
(`packages/execution/src/model-bridge.ts` → `ModelRouter.stream`):

| Recorded shape replayed | Non-streaming `complete()` | Streaming `stream()` |
| --- | --- | --- |
| `content` = text above, no `tool_calls`, `finish_reason: "stop"` | `content` preserved, `toolCalls: []` | one `text-delta`, `done.toolCalls: []` |
| `content` + structured `tool_calls` in one message | both preserved | text deltas **and** `tool-call` event, `finish_reason: "tool_calls"` |
| `tool_calls: null` explicitly present | rejected as an unexpected shape (never silently dropped) | n/a (stream deltas omit the key) |

Conclusion:

- **Proved:** the adapter does not drop a structured `tool_calls` entry when
  `content` is also present, in either transport. Nothing in `@mars/providers`
  or `model-bridge.ts` parses tool calls out of assistant text, and nothing
  discards them when text is present.
- **Recorded, not re-proved here:** Ollama itself returned text only for the
  MARS-prompted request (the live replay in `local-model-run.txt`). No live
  model was called in this PR (`model_requests: 0` in every test).
- **Inferred:** Qwen3-Coder emitted its native text tool-call syntax and
  Ollama's OpenAI-compatible parser did not convert it; the fixed MARS system
  prompt is the trigger (see the replay matrix in `local-model-run.txt`).

## Consequence in MARS

Tool execution stays on the validated structured-call path. Assistant text
that looks like a tool call is never executed; the workbench host records it
as a diagnostic inside the verification verdict
(`VerificationEvidenceRecord.diagnostics`) and the run's verification is
`failed` with `Required file missing: <path>` when a required file check was
declared at launch. `completed` remains the execution status.
