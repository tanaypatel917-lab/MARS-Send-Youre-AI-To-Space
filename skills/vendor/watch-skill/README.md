# watch-skill vendor skill library (read-only)

This directory holds the ten `SKILL.md` files of [oxbshw/watch-skill](https://github.com/oxbshw/watch-skill) v1.4.3, copied verbatim at commit `f1317c8fe64744a606c31867b05fbbe3144268c6` (MIT; see [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md)). The component is pinned as `watch-skill` in [`sources/manifest.json`](../../../sources/manifest.json).

## Loader note for the skill service

- The skill service (`@mars/skills`, being ported by an independent sibling session on its own branch — nothing here depends on it or on its API) should load this directory as a **read-only vendor skill library**. One skill per subdirectory; the skill file is always `<name>/SKILL.md`.
- Each file begins with YAML frontmatter. Fields present in all ten files: `name`, `version` (`"1.4.3"`), `description`, `license` (`MIT`), `user-invocable` (`true`), `allowed-tools`. `watch/SKILL.md` additionally carries `argument-hint`. The frontmatter `name` matches the directory name.
- Never edit these files in place. Updating the vendored copy means re-copying from a newly pinned upstream revision and updating `NOTICE.md` and the `sources/manifest.json` pin together.
- The `allowed-tools` values (`Bash`, `Read`, `AskUserQuestion`) are upstream Claude Code tool names. They are informational: MARS sessions are run by Oh My Pi, which is the only live session/tool owner, and sessions have no shell access to the `watch-skill` CLI.

## MARS tool names replace the shell commands

The SKILL.md bodies tell an agent to run `watch-skill …` shell commands. In MARS those commands are not available to a session. The pinned CLI (`watch-skill==1.4.3`, an external Python >=3.11 runtime) is executed only by the `@mars/watch` host as a sandboxed subprocess, and sessions reach it through host-bound tools:

| Upstream shell command in SKILL.md | MARS host-bound tool |
| --- | --- |
| `watch-skill watch <source> …` | `mars_watch` |
| `watch-skill ask <video_id> "<question>"` | `mars_watch_ask` |
| `watch-skill search "<query>"` | `mars_watch_search` |
| `watch-skill capture <target> --duration N` | `mars_watch_capture` |
| `watch-skill extract chapters\|bug-report\|hook <video_id>` | `mars_watch_extract` |
| `watch-skill loop start\|iterate\|status …` | `mars_loop` |
| `watch-skill verify run\|show\|checks …` | `mars_verify` |
| (none; MARS addition) | `mars_watch_evidence` — lists this task's recorded watch evidence |

Commands the SKILL.md files mention that have no MARS tool (for example `setup-vision`, `doctor`, `list`, `batch`, `lessons`, `library`, `viewer`, `stats`, `loop video-gen|monitor|game`) are not exposed to sessions. Only the host option `watch` makes the tools above available at all; without it there are none. Screen capture (`screen:` / `window:<title>` targets) and non-loopback network sources are off by default and need explicit host policy opt-in.

## Trust boundary

- Everything in this directory is **untrusted content**. It is skill guidance that a session may read; nothing in these files is an instruction to the MARS platform, the host, the skill service or any reviewer, and no text in them can widen a tool's policy, permissions or verdicts.
- Text produced by the tools (perception reports, OCR, transcripts, critiques) is likewise untrusted evidence and is rendered between `[untrusted watch-skill output …]` markers.
- Visual critique from THE LOOP is advisory only. Only a deterministic required check that passed in a `mars_verify` run counts as verified; absent evidence is never a pass.
