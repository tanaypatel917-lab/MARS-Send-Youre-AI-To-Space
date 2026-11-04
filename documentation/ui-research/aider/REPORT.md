# Aider — UI research for the MARS terminal client / MARS Shell

| | |
|---|---|
| Product | Aider (`aider-chat`, terminal pair-programming TUI, Python/prompt_toolkit) |
| Version run | `Aider v0.86.2` (pip `aider-chat==0.86.2`, Python 3.12.13, Ubuntu 22.04, xfce4-terminal, DejaVu Sans Mono 12) |
| Source rev | tag `v0.86.2` = `253f0368b873ba30d8ee26e463718f0c03614ddf` (github.com/Aider-AI/aider) |
| License | Apache-2.0 — https://github.com/Aider-AI/aider/blob/v0.86.2/LICENSE.txt |
| Date | 2026-11-03 |
| Run vs read | **Ran**: `aider --help`; TUI with `--no-auto-commits --model gpt-4o` and a dummy `OPENAI_API_KEY=sk-dummy` in a 3-file git repo (so every LLM call fails with an auth error; all local UI — `/help /add /drop /ls /tokens /settings /diff /undo /run /map /architect /ask /code /voice /model /reasoning-effort` — was exercised). **Read**: official docs at aider.chat (usage/commands, repomap, usage/modes, usage/voice, usage/watch, usage/notifications, usage/lint-test, git, troubleshooting/token-limits, usage/tips), all read 2026-11-03. No source files were read; `[source]` is not used in this report. |
| Comparison basis | "Beats" = better than Claude Code, Codex CLI, Hermes and Oh My Pi on that specific point, judged from general product knowledge of those four as of 2026-11; I did not re-run the four primaries in this session, so each comparison is marked `[comparison: not re-verified]`. |

## Findings by question

### Repo-map concept display
- `[ran]` Startup banner line: `Repo-map: using 4096 tokens, auto refresh` (budget + refresh policy in one line, printed next to `Main model: gpt-4o with diff edit format` and `Weak model: gpt-4o-mini`). Screenshot `aider-02-banner.png`.
- `[ran]` `/map` prints the exact map the model sees, prefixed with the instruction text sent to the model: `Here are summaries of some files present in my git repository. Do not propose changes to these files, treat them as *read-only*. If you need to edit any of these files, ask me to *add them to the chat* first.` then per file `util.py:` with elided rows shown as `⋮...` and a `│` gutter before each kept signature line (`│def read(path):`). Files already in chat are excluded from the map. Screenshot `aider-09-modes-map.png`.
- `[docs]` Map = tree-sitter symbols ranked by a dependency graph, trimmed to `--map-tokens` (default 1k; the model config set 4096 here); `--map-refresh {auto,always,files,manual}`; `/map-refresh` forces it. https://aider.chat/docs/repomap.html

### `/add`, `/drop`, `/ls`
- `[ran]` `/add app.py` → `Added app.py to the chat`. From then on a green **files-in-chat line** (`app.py`) is printed directly above every `> ` prompt, so the active context set is always visible without a command. `/drop app.py` → `Removed app.py from the chat` and the line disappears. Screenshots `aider-04-tokens.png`, `aider-11-ls-drop-model.png`.
- `[ran]` `/add newfile.py` for a missing path → `No files matched 'newfile.py'. Do you want to create /tmp/aider-play/newfile.py? (Y)es/(N)o [Yes]:` (absolute path shown, default Yes). Screenshot `aider-08-diff-undo-newfile.png`.
- `[ran]` `/ls` prints two lists: `Repo files not in the chat:` and `Files in chat:`.
- `[docs]` `/read-only` adds files the model may read but not edit; `/add` accepts globs. https://aider.chat/docs/usage/commands.html

### `/diff` and `/undo`
- `[ran]` With nothing to show: `/diff` → orange `No changes to display since the last message.`; `/undo` → red `This is the first commit in the repository. Cannot undo.` (both are exact strings).
- `[docs]` `/diff` = diff of changes since the last message; `/undo` = `git revert`-style undo of the last commit **only if aider made it**; aider auto-commits each edit with a Conventional-Commits message written by the weak model, commits pre-existing dirty files separately first, and appends `(aider)` to the git author/committer name (`--attribute-author`, `--attribute-committer`, `--attribute-co-authored-by`). https://aider.chat/docs/git.html

### `/tokens` cost table and per-message cost
- `[ran]` Exact output (dummy key, gpt-4o pricing from litellm metadata):
  ```
  Approximate context window usage for gpt-4o, in tokens:
  $ 0.0050    2,003 system messages
  $ 0.0002       69 repository map  use --map-tokens to resize
  $ 0.0001       33 app.py          /drop to remove
  ==================
  $ 0.0053    2,105 tokens total
            125,895 tokens remaining in context window
            128,000 tokens max context window size
  ```
  Each row carries cost, tokens, source **and the remedy** (`use --map-tokens to resize`, `/drop to remove`). Screenshot `aider-04-tokens.png`.
- `[docs]` After every assistant message aider prints a one-line footer `Tokens: Nk sent, Nk received. Cost: $X message, $Y session.` (not reproducible here because the dummy key fails before any response). https://aider.chat/docs/usage/commands.html, https://aider.chat/docs/troubleshooting/token-limits.html
- `[ran]` `/settings` dumps every option plus per-model metadata blocks (`input_cost_per_token`, `output_cost_per_token`, `max_input_tokens`, `max_output_tokens`, `supports_function_calling`, …, with a `source:` pricing URL) for Main, Editor and Weak model. Screenshot `aider-05-settings.png`.
- `[docs]` Token-limit errors are structured: `Model gpt-3.5-turbo has hit a token limit!` / `Input tokens: 768 of 16385` / `Output tokens: 4096 of 4096 -- exceeded output limit!` / `Total tokens: 4864 of 16385` / `To reduce output tokens: - Ask for smaller changes…`. https://aider.chat/docs/troubleshooting/token-limits.html

### File-change summary lines
- `[docs]` After applying edits aider prints `Applied edit to <file>` per file and then `Commit <sha> <message>`; with `--show-diffs` the diff is printed. Not observed here (no successful model call). https://aider.chat/docs/git.html

### `--pretty` rich output
- `[ran]` Default `--pretty` renders: user input and prompt in green, tool errors red, warnings orange, assistant text default colour, a full-width green rule between turns. Flags seen in `aider --help`: `--pretty/--no-pretty`, `--stream`, `--dark-mode/--light-mode`, `--user-input-color`, `--tool-output-color`, `--tool-error-color`, `--tool-warning-color`, `--assistant-output-color`, `--code-theme`, `--fancy-input`, `--multiline`.
- `[ran]` An LLM auth failure is shown as red text with the raw exception (`litellm.AuthenticationError: … Incorrect API key provided: sk-dummy …`), a plain-English line `The API provider is not able to authenticate you. Check your API key.`, the help URL highlighted, and a follow-up prompt `Open URL for more info? (Y)es/(N)o/(D)on't ask again [Yes]:` while a `Waiting for gpt-4o` retry status spins underneath. Screenshot `aider-06-auth-error.png`.

### Voice
- `[ran]` `/voice` → `Initializing sound device...` then red `Unable to import `sounddevice` and/or `soundfile`, is portaudio installed?` (graceful, actionable failure).
- `[docs]` With audio: `Recording, press ENTER when done... 3.5sec`, transcript is inserted as the user message, Whisper via the configured provider; `--voice-format`, `--voice-language`. https://aider.chat/docs/usage/voice.html

### Architect / editor modes
- `[ran]` `/architect` re-prints the model banner: `Main model: gpt-4o with architect edit format` / `Editor model: gpt-4o with editor-diff edit format` / `Weak model: gpt-4o-mini`; prompt becomes `architect> `. `/ask` → `ask> `; `/code` → `> `. Screenshot `aider-09-modes-map.png`.
- `[docs]` Modes `code`, `ask`, `architect`, `help`; `/ask <text>` is one-shot, bare `/ask` is sticky; `--editor-model`, `--auto-accept-architect`. https://aider.chat/docs/usage/modes.html

### Asking before adding files / running commands
- `[ran]` `/run ls -la` prints the output then asks `Add 0.3k tokens of command output to the chat? (Y)es/(N)o [Yes]:` — the consent prompt quantifies the context cost. Screenshot `aider-10-run-output-prompt.png`.
- `[ran]` Typed text while a y/n prompt is active is rejected with `Please answer with one of: yes, no, skip, all, don't` (the full answer vocabulary: yes/no/skip/all/don't). Screenshot `aider-07-run-prompt.png`.
- `[ran]` First-run prompts: `Add .aider* to .gitignore (recommended)? (Y)es/(N)o [Yes]:` and `Would you like to see what's new in this version? (Y)es/(N)o [Yes]:`. Screenshot `aider-01-start.png`.
- `[docs]` When the model proposes a shell command, aider asks before running it (`--suggest-shell-commands`); `/test` adds output only on non-zero exit; `--auto-lint`/`--auto-test` run on edited files. https://aider.chat/docs/usage/lint-test.html

### Input editor
- `[docs]` Multiline via `{` … `}` or `{tag` … `tag}` fences, `Meta-Enter`, or `/multiline-mode` (swaps Enter/Meta-Enter); `Ctrl-X Ctrl-E` opens `$EDITOR`; docs explicitly say Shift-Enter cannot be detected portably. `Ctrl-C` is always safe; the partial response stays in the transcript. https://aider.chat/docs/usage/commands.html, https://aider.chat/docs/usage/tips.html
- `[docs]` `--watch-files`: comments ending in `AI!` (do it) or `AI?` (answer) in any editor trigger aider; `--notifications` runs `notify-send`/`zenity` when the LLM is done and waiting. https://aider.chat/docs/usage/watch.html, https://aider.chat/docs/usage/notifications.html

## Findings that clearly beat Claude Code / Codex / Hermes / Oh My Pi

1. **Cost table where every row names its own remedy.** `[ran]` `/tokens` lists `$ cost | tokens | source | fix` (`use --map-tokens to resize`, `/drop to remove`) plus remaining/max context. The four primaries show totals or a percentage, not per-source rows with an inline fix `[comparison: not re-verified]`. → MARS: `/context` (or the status footer click) renders the same four-column table from the workbench RPC's context accounting; each row's remedy is a clickable proposal (`drop`, `shrink map`, `compact`).
2. **Consent prompts quantify what you are consenting to.** `[ran]` `Add 0.3k tokens of command output to the chat?` → MARS: every "attach to context" proposal (tool output, file, URL) shows the token size and, for paid models, the marginal $ before the user confirms.
3. **Persistent files-in-chat line above the prompt.** `[ran]` The context set is visible at every prompt without a command and disappears when emptied. → MARS: a one-line "pinned context" strip above the composer in both TUI and Shell (chips in Shell), fed by the same context list; it is the place the user removes items.
4. **Mode and model wiring are re-stated on every mode switch.** `[ran]` `/architect` prints which model handles which edit format and changes the prompt string (`architect> `, `ask> `). → MARS: switching plan/ask/code modes prints a compact banner `plan · <model> · tools: read-only` and changes the prompt glyph; never a silent toggle.
5. **Errors carry a plain-English cause + the remedy vocabulary.** `[ran]/[docs]` Auth error = raw exception + `Check your API key.` + an offer to open the help URL; token-limit error lists `To reduce output tokens: …`. → MARS: the error renderer has three slots (raw, cause, next actions as proposals) and never shows only the raw.
6. **Editor-side triggers (`AI!` / `AI?` comments) and `--notifications`.** `[docs]` Work can be requested from any editor and the TUI notifies when it is waiting. → MARS: the host already watches files (`documentation/WATCH.md`); expose a `mars watch --ai-comments` trigger that turns `AI!`/`AI?` into *proposed* tasks (never auto-run), and a desktop notification when a proposal needs confirmation.
7. **Provenance in git by default.** `[docs]` Author name gets `(aider)` appended; optional `Co-authored-by` trailer; `/undo` only undoes aider's own commits. → MARS: when the user approves a commit proposal, the commit message gets a `MARS-Run: <run-id>` trailer and the author suffix; `/undo` is scoped to MARS-authored commits.

## Nothing better here
- Input editing: no Shift-Enter, fenced `{}` multiline, prompt_toolkit single-line default — Claude Code, Codex and Oh My Pi all have better composers `[comparison: not re-verified]`.
- No streaming tool-call UI, no progress indicators beyond `Waiting for gpt-4o`, no diff review UI (accept-all by git commit, reject by `/undo`).
- y/n prompts swallow unrelated keystrokes (`Please answer with one of: …`), and first-run prompts (`.gitignore`, "what's new") interrupt startup.

## Patterns worth borrowing
| Pattern | Rule it embodies | MARS build note |
|---|---|---|
| Per-row cost/remedy table | Make cost legible *and* actionable at the same place | `/context` view: columns cost, tokens, source, remedy; remedy = proposal button/keys |
| Quantified consent | Never ask "add this?" without the size | Proposal cards show `+N tokens` (and `$` for paid) before Confirm |
| Files-in-chat strip | Context should be visible without a command | One-line strip above composer; `x`/click removes; mirrors RPC context list |
| Mode banner on switch | State changes must be announced, not implied | Banner line + prompt glyph change on mode/model change |
| Three-slot errors | Raw + cause + next step | Error component in `pi-tui` with collapsible raw block |
| `/undo` scoped to agent commits | Undo must be safe and predictable | Only revert commits with the MARS trailer; otherwise refuse with reason |
| `AI!`/`AI?` comment triggers | Meet the user where they type | Watcher emits proposals, not actions |

## Do not borrow / conflicts
- **Auto-commit after every edit** (default) and `--yes-always`: conflicts with "follow-up actions are proposals the user confirms". MARS: edits land in the sandbox workspace; commit is a proposal.
- **`/run` executes in the host shell immediately** (then asks only about adding the output): conflicts with "execution only inside an approved sandbox". MARS: `/run` is a sandboxed command proposal; the *output attach* question survives.
- **`Open URL for more info?` defaulting to Yes and `--detect-urls` auto-scraping pasted URLs**: model-adjacent content fetched on a default-yes prompt; MARS should default to No and show the domain.
- **Default paid model (`gpt-4o`) with no free-tier step**: conflicts with "free models first, paid only with explicit consent". MARS: default to the free runtime model; paid model selection prints the price table (`/settings`-style metadata is worth copying, the default is not).
- **Shell-command suggestions executed on `y`** (`--suggest-shell-commands`): model output is untrusted; MARS keeps the suggestion as a proposal with the command shown verbatim and run in the sandbox.
- Aider is a standalone multi-model client (main/editor/weak models); MARS has a single runtime behind the host, so the "weak model for commit messages" idea maps to a host-side cheap-model policy, not to client-side model routing.

## Evidence appendix
Commands run (2026-11-03):
```
python3 -m pip install -q aider-chat            # -> aider 0.86.2
aider --help > /tmp/docs/aider-help.txt
cd /tmp/aider-play && git init && git add app.py util.py README.md && git commit -m init
OPENAI_API_KEY=sk-dummy aider --model gpt-4o --no-auto-commits --no-check-update --no-analytics
# in TUI: y (gitignore), n (what's new), /help, /add app.py, /tokens, /settings, "add a multiply(a, b) function to app.py",
#         /run ls -la, n, /diff, /undo, /add newfile.py, n, /architect, /voice, /ask, /code, /map, /ls, /drop app.py, /model, /reasoning-effort, /exit
```
Source/license: tag `v0.86.2` → `253f0368b873ba30d8ee26e463718f0c03614ddf`; LICENSE.txt (Apache-2.0) at that tag: https://github.com/Aider-AI/aider/blob/v0.86.2/LICENSE.txt

Docs read (2026-11-03): https://aider.chat/docs/usage/commands.html · https://aider.chat/docs/repomap.html · https://aider.chat/docs/usage/modes.html · https://aider.chat/docs/usage/voice.html · https://aider.chat/docs/usage/watch.html · https://aider.chat/docs/usage/notifications.html · https://aider.chat/docs/usage/lint-test.html · https://aider.chat/docs/git.html · https://aider.chat/docs/troubleshooting/token-limits.html · https://aider.chat/docs/usage/tips.html

Screenshots (all taken by me from xfce4-terminal on the session desktop):
- `aider-01-start.png` — first-run `.gitignore` prompt.
- `aider-02-banner.png` — startup banner: version, main/weak model + edit format, git repo file count, repo-map budget.
- `aider-03-help.png` — `/help` two-column slash-command table.
- `aider-04-tokens.png` — `/tokens` cost table with per-row remedies; files-in-chat line above the prompt.
- `aider-05-settings.png` — `/settings` per-model pricing/capability metadata.
- `aider-06-auth-error.png` — auth failure: raw error, plain-English cause, `Open URL…?` prompt, `Waiting for gpt-4o`.
- `aider-07-run-prompt.png` — typed command swallowed by an active y/n prompt (`Please answer with one of: …`).
- `aider-08-diff-undo-newfile.png` — `/diff` and `/undo` empty-state strings; `/add` missing-file create prompt.
- `aider-09-modes-map.png` — `/architect`, `/ask`, `/code` banners and prompt strings; `/map` output with `⋮...` elision.
- `aider-10-run-output-prompt.png` — `/run ls -la` then `Add 0.3k tokens of command output to the chat?`.
- `aider-11-ls-drop-model.png` — `/ls`, `/drop`, `/model`, `/reasoning-effort` outputs.
