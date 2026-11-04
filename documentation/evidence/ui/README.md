# UI PR 1 — fixture evidence

**Fixture evidence only.** Everything here comes from `mars session --fixture demo`, which serves the
`packages/ui-core/fixtures/` data from an in-process stand-in for the workbench RPC. There is no
workbench, no model, no OmniRoute and no network in these runs; nothing here shows a live task or a
real terminal emulator other than tmux.

- `session-fixture.cast` — asciinema v2 recording of a 120×40 tmux pane (`record.sh` reproduces it).
- `step-*.ans` — `tmux capture-pane -e` frames at each step; `step-*.png` are those frames rendered
  to HTML by `ans2html.py` and captured with headless Chrome (fonts may lack a few glyphs such as `⎿`).

Steps: transcript → focus + expand a card (`Shift+Up`, `Ctrl+O`) → `/tasks` → `/graph` →
`/proposals` → `/model` → `/context` → `/resume` (frozen launch settings) → `/help` → `/cancel`
(answered as "not available in this read-only client yet") → `Ctrl+C` twice.

Reproduce: `PATH=$HOME/.local/bin:$PATH documentation/evidence/ui/record.sh` (needs `tmux` and `asciinema`).
