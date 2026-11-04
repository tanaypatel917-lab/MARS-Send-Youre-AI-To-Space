#!/usr/bin/env bash
# Fixture evidence only: drives `mars session --fixture demo` in a 120×40 tmux pane under asciinema.
# No workbench, no model, no network. Writes session-fixture.cast and per-step ANSI captures.
set -euo pipefail
cd "$(dirname "$0")/../../.."
out=documentation/evidence/ui
rm -f "$out"/session-fixture.cast "$out"/step-*.ans
tmux kill-session -t mars-ui-evidence 2>/dev/null || true
tmux new-session -d -s mars-ui-evidence -x 120 -y 40 \
  "COLORTERM=truecolor TERM=xterm-256color asciinema rec -q --cols 120 --rows 40 -c 'bun apps/cli/src/main.ts session --fixture demo' $out/session-fixture.cast"
step() { sleep "${2:-1}"; tmux capture-pane -e -p -t mars-ui-evidence >"$out/step-$1.ans"; }
keys() { tmux send-keys -t mars-ui-evidence "$@"; sleep 0.3; }
close() { keys Escape; sleep 0.5; }
step 1-transcript 6
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do keys S-Up; done
keys C-o; step 2-expanded-card
keys "/tasks" Enter; step 3-tasks
close; keys "/graph" Enter; step 4-graph
close; keys "/proposals" Enter; step 5-proposals
close; keys "/model" Enter; step 6-model
close; keys "/context" Enter; step 7-context
close; keys "/resume" Enter; step 8-resume
close; keys "/help" Enter; step 9-help
close; keys "/cancel" Enter; step 10-staged-command
keys C-c C-c
sleep 2
tmux kill-session -t mars-ui-evidence 2>/dev/null || true
