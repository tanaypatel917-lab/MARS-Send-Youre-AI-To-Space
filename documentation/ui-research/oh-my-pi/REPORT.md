# Oh My Pi (`@oh-my-pi/pi-coding-agent` + `@oh-my-pi/pi-tui`) — TUI, theme, keybinding and extension-point study

| | |
|---|---|
| Product | Oh My Pi (`omp`), https://github.com/can1357/oh-my-pi |
| Version run | `omp v18.14.0` (`--version` prints `omp/18.14.0`), packages `@oh-my-pi/pi-coding-agent@18.14.0`, `@oh-my-pi/pi-tui@18.14.0` as installed by `bun install` in this repo |
| Revisions | npm release claims commit `31147f9d1a76608549821c3759f8487b4d66c72d` (all GitHub links below are pinned to it). The repo's `sources/manifest.json` pins the *audited* revision `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611`; the two differ, so source citations here use the **installed** files, which correspond to the npm release, and may not match the audited tree line-for-line. |
| License | MIT (`LICENSE`: "MIT License, Copyright (c) 2025 Mario Zechner"), https://github.com/can1357/oh-my-pi/blob/31147f9d1a76608549821c3759f8487b4d66c72d/LICENSE |
| Date | 2026-11-02 |
| Run | `bun node_modules/.bun/@oh-my-pi+pi-coding-agent@18.14.0+*/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts` inside `xterm` (DejaVu Sans Mono 13pt, `TERM=xterm-256color COLORTERM=truecolor`, 2560×1920 X display) with no API key and no prior `~/.omp`. Walked the 5-step setup wizard, the main screen, `/settings`, `/model`, `/hotkeys`; `/theme` and `/help` could not be opened (see §Q1/§Q10). The approval dialog was unreachable (no model). Also ran `--help`. |
| Read | Installed source of both packages (paths below are relative to `pi-tui/src` = `node_modules/.bun/@oh-my-pi+pi-tui@18.14.0/node_modules/@oh-my-pi/pi-tui/src` and `coding-agent/src` = `node_modules/.bun/@oh-my-pi+pi-coding-agent@18.14.0+*/node_modules/@oh-my-pi/pi-coding-agent/src`), and `docs/*.md` fetched from GitHub at `31147f9d`. |

Evidence tags: `[ran]` observed in the running TUI, `[source]` read in installed code, `[docs]` official `docs/` at revision `31147f9d` (read 2026-11-02), `[third-party]` none used. Anything not tagged "not verified" was checked.

Source URL prefix used below: `https://github.com/can1357/oh-my-pi/blob/31147f9d1a76608549821c3759f8487b4d66c72d/packages/tui/src/` for `pi-tui/src/…` and `…/packages/coding-agent/src/` for `coding-agent/src/…` (the monorepo layout is given in `docs/rpc.md`, which cites `packages/coding-agent/src/modes/rpc/rpc-types.ts`).

---

## Q1. Theme system

**Architecture** `[source]` `pi-tui/src/theme/schema.ts`, `theme.ts`, `theme-class.ts`, `loader.ts`, `color.ts`:
- A theme is a JSON document (`ThemeJson`): `{ $schema?, name, vars?: Record<string, color>, colors: Record<ThemeColor|ThemeBg, color>, export?: {pageBg, cardBg, infoBg}, terminal?: {background, foreground, chrome, widget, ansi: color[16]}, symbols?: {preset: "unicode"|"nerd"|"ascii", overrides: Record<SymbolKey,string>, spinnerFrames} }`. `colors` values may be a hex string, a `vars` name (bare, e.g. `"blue"`), a 0-255 ANSI index, or `""` meaning "terminal default foreground".
- `Theme` class (`theme-class.ts`) constructor: `(fgColors, bgColors, mode: "truecolor"|"256color", symbolPreset, symbolOverrides, spinnerFramesOverrides)`. Methods used everywhere: `theme.fg(token, text)`, `theme.bg(token, text)`, `theme.bgFill(token, text)` (fills to width), `theme.fgOnBg`, `theme.bold`, `theme.italic`, `theme.getColorMode()`, `theme.sep.*`, `theme.icon.*`.
- `ColorMode` has exactly two values: `truecolor` and `256color` (`schema.ts`). **There is no 16-colour mode.** `detectColorMode()` (`color.ts`): `WT_SESSION` ⇒ truecolor, else `getTerminalInfo(detectTerminalId()).trueColor`; `terminal-capabilities.ts` marks kitty, ghostty, wezterm, iterm2, vscode, alacritty, orca, warp, otty, rio, tern as truecolor and otherwise requires `COLORTERM=truecolor|24bit`. Hex is converted with `Bun.color(hex, "ansi-16m" | "ansi-256")` `[docs: theme.md §Terminal color mode behavior]`.
- **`NO_COLOR` is not honoured for theme colours** `[source]`: the only consumer in `pi-tui` is `render/hyperlink.ts` (disables OSC 8 hyperlinks in "auto" mode); the coding agent also passes it to non-interactive subprocesses. Report as: colours cannot be globally disabled; the nearest thing is the ASCII-safe theme/symbol preset.

**Semantic groups and every token with defaults** `[source]` `theme/dark.json`, `theme/light.json`, `theme/defaults.json` (100 bundled themes; the default dark theme in the coding agent is **`titanium`**, default light is **`light`** — `coding-agent/src/modes/settings.ts` keys `theme.dark`, `theme.light`). `dark.json` palette vars: cyan `#0088fa`, blue `#178fb9`, green `#89d281`, red `#fc3a4b`, yellow `#e4c00f`, gray `#777d88`, dimGray `#5f6673`, darkGray `#3d424a`, accent `#febc38`, selectedBg `#31363f`, userMsgBg `#221d1a`, toolPendingBg `#1d2129`, toolSuccessBg `#161a1f`, toolErrorBg `#291d1d`, customMsgBg `#2a2530`. `light.json` vars: teal `#5a8080`, blue `#547da7`, green `#588458`, red `#aa5555`, yellow `#9a7326`, mediumGray `#6c6c6c`, dimGray `#767676`, lightGray `#b0b0b0`, selectedBg `#d0d0e0`, userMsgBg `#e8e8e8`, toolPendingBg `#e8e8f0`, toolSuccessBg `#e8f0e8`, toolErrorBg `#f0e8e8`, customMsgBg `#ede7f6`. `titanium` vars: brushedTitanium `#151820`, darkTitanium `#0f1216`, electricBlue `#00b4ff`, deepBlue `#0082b3`, titaniumGold `#d4c090`, brightAluminum `#e8ecf4`, dimAluminum `#9ca3b0`, warningAmber `#ffb347`, readoutGreen `#00ff88`, alertRed `#ff4757`, subtleGray `#2a3038`.

Groups (per `docs/theme.md` §Required and optional color tokens): core text/borders (11): `accent border borderAccent borderMuted success error warning muted dim text selectedBg`; background blocks (7): `userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg statusLineBg selectedBg`; message/tool text: `userMessageText customMessageText customMessageLabel toolTitle toolOutput` (+ optional `assistantMessageText`); markdown (10): `mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdHr mdListBullet mdTable`; diff+syntax (12): `toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation`; mode/thinking borders (8+1): `thinkingText thinkingBorderOff thinkingBorderMinimal thinkingBorderLow thinkingBorderMedium thinkingBorderHigh thinkingBorderXhigh thinkingBorderMax` (+ `thinkingMax`), `bashMode pythonMode`; status-line segments (13): `statusLineModel statusLineMode statusLinePath statusLineGit statusLineTokens statusLineCost statusLineContext statusLineTime statusLineDefault statusLineSubagents statusLineUsage statusLineSession statusLineCollab`; subagent tokens `subagentDot subagentLabel`.

Full table (values resolved through each theme's `vars`; `""` = terminal default):

| token | dark.json | light.json | titanium (default dark) |
|---|---|---|---|
| `accent` | `#febc38` | `#5a8080` | `#00b4ff` |
| `border` | `#178fb9` | `#547da7` | `#2a3038` |
| `borderAccent` | `#0088fa` | `#5a8080` | `#00b4ff` |
| `borderMuted` | `#3d424a` | `#b0b0b0` | `#1f252d` |
| `success` | `#89d281` | `#588458` | `#00ff88` |
| `error` | `#fc3a4b` | `#aa5555` | `#ff4757` |
| `warning` | `#e4c00f` | `#9a7326` | `#ffb347` |
| `muted` | `#777d88` | `#6c6c6c` | `#9ca3b0` |
| `dim` | `#5f6673` | `#767676` | `#6b7280` |
| `text` | `"" (terminal default)` | `"" (terminal default)` | `"" (terminal default)` |
| `thinkingText` | `#777d88` | `#6c6c6c` | `#9ca3b0` |
| `selectedBg` | `#31363f` | `#d0d0e0` | `#0082b3` |
| `userMessageBg` | `#221d1a` | `#e8e8e8` | `#0f1216` |
| `userMessageText` | `"" (terminal default)` | `"" (terminal default)` | `"" (terminal default)` |
| `customMessageBg` | `#2a2530` | `#ede7f6` | `#2a3038` |
| `customMessageText` | `"" (terminal default)` | `"" (terminal default)` | `"" (terminal default)` |
| `customMessageLabel` | `#b281d6` | `#7e57c2` | `#d4c090` |
| `toolPendingBg` | `#1d2129` | `#e8e8f0` | `#0f1216` |
| `toolSuccessBg` | `#161a1f` | `#e8f0e8` | `#0f1216` |
| `toolErrorBg` | `#291d1d` | `#f0e8e8` | `#1a0f10` |
| `toolTitle` | `"" (terminal default)` | `"" (terminal default)` | `"" (terminal default)` |
| `toolOutput` | `#777d88` | `#6c6c6c` | `#9ca3b0` |
| `mdHeading` | `#febc38` | `#9a7326` | `#00b4ff` |
| `mdLink` | `#0088fa` | `#547da7` | `#00b4ff` |
| `mdLinkUrl` | `#5f6673` | `#767676` | `#0082b3` |
| `mdCode` | `#e5c1ff` | `#5a8080` | `#00ff88` |
| `mdCodeBlock` | `#9CDCFE` | `#588458` | `#9ca3b0` |
| `mdCodeBlockBorder` | `#777d88` | `#6c6c6c` | `#2a3038` |
| `mdQuote` | `#777d88` | `#6c6c6c` | `#9ca3b0` |
| `mdQuoteBorder` | `#3d424a` | `#6c6c6c` | `#2a3038` |
| `mdHr` | `#3d424a` | `#6c6c6c` | `#2a3038` |
| `mdListBullet` | `#febc38` | `#588458` | `#00b4ff` |
| `toolDiffAdded` | `#89d281` | `#588458` | `#00ff88` |
| `toolDiffRemoved` | `#fc3a4b` | `#aa5555` | `#ff4757` |
| `toolDiffContext` | `#777d88` | `#6c6c6c` | `#9ca3b0` |
| `link` | `#0088fa` | `—` | `—` |
| `syntaxComment` | `#6A9955` | `#008000` | `#6b7280` |
| `syntaxKeyword` | `#569CD6` | `#0000FF` | `#00b4ff` |
| `syntaxFunction` | `#DCDCAA` | `#795E26` | `#00ff88` |
| `syntaxVariable` | `#9CDCFE` | `#001080` | `#e8ecf4` |
| `syntaxString` | `#CE9178` | `#A31515` | `#d4c090` |
| `syntaxNumber` | `#B5CEA8` | `#098658` | `#ffb347` |
| `syntaxType` | `#4EC9B0` | `#267F99` | `#00b4ff` |
| `syntaxOperator` | `#D4D4D4` | `#000000` | `#00b4ff` |
| `syntaxPunctuation` | `#D4D4D4` | `#000000` | `#9ca3b0` |
| `thinkingOff` | `#3d424a` | `#b0b0b0` | `#4a5058` |
| `thinkingMinimal` | `#5f6673` | `#767676` | `#5a6068` |
| `thinkingLow` | `#178fb9` | `#547da7` | `#6a7078` |
| `thinkingMedium` | `#0088fa` | `#5a8080` | `#9ca3b0` |
| `thinkingHigh` | `#b281d6` | `#875f87` | `#00b4ff` |
| `thinkingXhigh` | `#e5c1ff` | `#8b008b` | `#d4c090` |
| `bashMode` | `#0088fa` | `#588458` | `#00ff88` |
| `statusLineBg` | `#121212` | `#e0e0e0` | `#0f1216` |
| `statusLineSep` | `244` | `#808080` | `#2a3038` |
| `statusLineModel` | `#d787af` | `#875f87` | `#00b4ff` |
| `statusLinePath` | `#00afaf` | `#005f87` | `#e8ecf4` |
| `statusLineGitClean` | `#5faf5f` | `#005f00` | `#00ff88` |
| `statusLineGitDirty` | `#d7af5f` | `#af5f00` | `#ffb347` |
| `statusLineContext` | `#8787af` | `#5f5f87` | `#9ca3b0` |
| `statusLineSpend` | `#5fafaf` | `#005f5f` | `#d4c090` |
| `statusLineStaged` | `70` | `28` | `#00ff88` |
| `statusLineDirty` | `178` | `136` | `#ffb347` |
| `statusLineUntracked` | `39` | `31` | `#9ca3b0` |
| `statusLineOutput` | `205` | `133` | `#0082b3` |
| `statusLineCost` | `205` | `133` | `#d4c090` |
| `statusLineSubagents` | `#febc38` | `#5a8080` | `#00b4ff` |
| `pythonMode` | `#e4c00f` | `#9a7326` | `#f0c040` |

**Custom theme file** `[source]` `theme/loader.ts` + `pi-utils` `getCustomThemesDir()`; `[docs]` theme.md §Built-in vs custom theme sources, §Creating a custom theme: a file `~/.omp/agent/themes/<name>.json` (agent dir is `~/.omp/agent`, overridable via `PI_CONFIG_DIR`, profiles under `~/.omp/profiles/<name>`) with the `ThemeJson` shape above; it is validated against `theme-schema.json`, an invalid file falls back to `dark`, and a file watcher (`startThemeWatcher`) hot-reloads the active theme when the file changes. Built-ins are embedded in `theme/defaults.json` (100 names, e.g. `alabaster, amethyst, anthracite, basalt, birch, graphite, limestone, mahogany, marble, obsidian, onyx, pearl, porcelain, quartz, sandstone, titanium, dark, light, dark-*/light-* variants`).

**Switching** `[source]` `theme/theme.ts`: `initThemeSync()/initTheme()` pick dark vs light via `detectTerminalBackground()` (OSC 11 background query when the multiplexer allows it → `COLORFGBG` → macOS appearance → dark). `setAutoThemeMapping(dark, light)` + `enableAutoTheme()` follow terminal appearance changes; `setTheme(name)` switches and persists; `previewTheme(name)` is used by the selector for live preview without persisting; `themeEpoch` bumps so cached renders invalidate. Persistence: `~/.omp/agent/config.yml` keys `theme.dark`, `theme.light`, `symbolPreset`, `colorBlindMode` `[docs theme.md §Where theme settings are persisted]`. `[ran]` wizard step 5 ("Pick a theme") offered `Match terminal` ("Titanium in dark terminals, Light in light terminals"), `Titanium` ("Default dark theme"), `Light`, `Colorblind colors` ("Adjust red/green contrast"), `ANSI-safe` ("ASCII glyphs with the dark terminal theme"), `Browse all…`, with a live preview block (`✓ success ▲ warning ✗ error accent`, a sample status line `sonnet ~/project main +2 42% 0.18`, and the editor). `/theme` opens `ThemeSelectorComponent` (`overlays/theme-selector.ts`, `extends OverlayPanel`, built from `themePickerOptions(title, current)`); **not reached** in my run (see appendix).

**Colour-blind mode** `[source]` `theme/loader.ts` `COLORBLIND_ADJUSTMENT`: shifts `toolDiffAdded` hue by +60° (green → blue) with saturation ×0.71; setting `colorBlindMode` default `false`.

**Symbols / glyph bundles** `[source]` `theme/symbols.ts`, `theme/glyph-bundle.json`, `glyph-protocol.ts`: three presets `unicode` (default), `nerd`, `ascii` (`SymbolPreset`), per-theme `symbols.overrides`. Examples (unicode | nerd | ascii): `status.success ✔ |  | [ok]`, `status.error ✘ |  | [!!]`, `status.warning ⚠ |  | [!]`, `status.info ⓘ |  | [i]`, `status.pending ⏳ |  | [*]`, `status.running ⟳ |  | [~]`, `status.enabled ● |  | [x]`, `nav.cursor ❯ |  | >`, `nav.expand ▸ | + `, `nav.collapse ▾ | -`, `tree.branch ├─ | |--`, `tree.last └─ | '--`, `progress.filled ━ | =`, `progress.empty ─ | -`, round box `╭ ╮ ╰ ╯ ─ │` → `+ + + + - |`, context map `⛁ ⛃ ⛝ ⛶` → `# @ x .`, `thinking.minimal "○ min" | "󰪞 min" | "[min]"`. Spinner frames: unicode *status* `⣾⣽⣻⢿⡿⣟⣯⣷`, *activity* `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`; nerd status uses clock glyphs (`󱑖…`), ascii `| / - \`. The nerd preset does not require a patched font in supporting terminals: `glyph-protocol.ts` implements an APC `ESC _ 25a1 ; <verb> … ESC \` "Glyph Protocol" that uploads 270 glyph outlines from `glyph-bundle.json` (source font **JetBrainsMono NFM Regular 2.304, Nerd Fonts 3.5.1**) in-band; `TERMINAL.glyphProtocol` gates it. `[ran]` wizard step 3 "Choose glyph mode — Pick the row that renders cleanly in your terminal" shows the three rows with sample strings (`1 Nerd Font`, `2 Unicode` preselected, `3 ASCII`).

## Q2. Reusable components (export, constructor, what it renders, look)

All components implement `Component { render(width): readonly string[]; handleInput?(data); invalidate?(); dispose?() }` `[source pi-tui/src/tui.ts:252; docs/tui.md]`. Constructors from installed source (`[source]`; file in parentheses). Visual notes marked `[ran]` were seen in screenshots, others are inferred from code.

| Export (file) | Constructor / key props | Renders | Look |
|---|---|---|---|
| `Container` (`tui.ts`) | `new Container()`; `addChild/removeChild/clear/invalidate` | vertical stack of children | – |
| `TUI extends Container` (`tui.ts`) | `new TUI(terminal: Terminal, showHardwareCursor?, options?: TUIOptions)`; `start({clearScrollback?, deferInput?})`, `stop()`, `setFocus(c)`, `showOverlay(c, OverlayOptions{anchor,margin,width,minWidth…}) → OverlayHandle`, `hideOverlay()`, `requestRender()`, `addPaintListener`, `setFrameProvider(TerminalFrameProvider)` | root; owns history/viewport frame plan, overlay stack, inline images, native (Tern) rendering | – |
| `Box` (`components/box.ts`) | `new Box(paddingX=1, paddingY=1, bgFn?, border?)` | padded, optionally filled block | used for user bubbles and framed messages |
| `Text`, `TruncatedText`, `Spacer`, `Section` (`components/`) | `new Text(text, paddingX, paddingY)` | plain styled lines | – |
| `Editor` (`components/editor.ts`, 5470 lines) | `new Editor(theme: EditorTheme)`; `EditorTextAssistProvider`, `PasteOptions`, inline replacements | multi-line editor with wrapping, kill-ring, undo, autocomplete hooks | plain text, cursor via terminal |
| `Input` (`components/input.ts`) | single-line field | – | – |
| `SelectList` (`components/select-list.ts`) | `new SelectList(items: SelectItem[], maxVisible, theme: SelectListTheme)`; `onSelect`, `onCancel`, `MouseRoutable` | scrolling list with filter | `[ran]` `❯` cursor row in accent, "Type to search" footer, thin scrollbar at right |
| `SettingsList` (`components/settings-list.ts`) | `SettingsListOptions`, `SettingItem[]` | label/value rows with cycling values | `[ran]` two-column rows "Theme titanium", grouped under headers |
| `TabBar` (`components/tab-bar.ts`) | `new TabBar(label, tabs: Tab[], theme, initialIndex=0)` | one-row tab strip | `[ran]` selected tab filled with accent bg, others plain |
| `Table` (`components/table.ts`) | `new Table(rows, columns, options)` | aligned columns | `[ran]` `/hotkeys` tables use `┌─┬─┐` sharp box |
| `TreeView<T,K>` (`components/tree-view.ts`) | `TreeViewOptions` (flatten + prefix style) | tree with `├─ └─ │` prefixes | – |
| `ScrollView` (`components/scroll-view.ts`) | `new ScrollView(content: string[]|Component, options)` | clipped viewport with scrollbar | – |
| `Markdown` (`components/markdown.ts`, 4958 lines) | `new Markdown(text)`; streaming helpers `streamingMarkdownSource`, `speculativeStreamingSource` | markdown → styled lines (headings, code fences with syntax tokens, tables, quotes) | heading `mdHeading`, code `mdCode` |
| `Loader extends Text` (`components/loader.ts`) | `(tui, colorFn, mutedFn?, message)`; `SPINNER_ADVANCE_MS=80` | one spinner row | braille spinner + message |
| `CancellableLoader extends Loader` (`components/cancellable-loader.ts`) | same + `.signal` (AbortSignal), `.onAbort`, `.aborted` | spinner that cancels on interrupt key | – |
| `BorderedLoader extends Container` (`overlays/bordered-loader.ts`) | `new BorderedLoader(tui, theme, message)` | spinner inside a box | – |
| `ProgressBar` (`components/progress-bar.ts`) | `new ProgressBar(value|undefined, options)` | `━`/`─` bar (`progress.filled/empty`) | – |
| `Disclosure` (`components/disclosure.ts`) | `new Disclosure(options)` | `▸/▾` collapsible section | – |
| `KeyValueList` (`components/key-value-list.ts`) | `new KeyValueList(rows, options)` | aligned key: value rows | – |
| `MetricRow` (`components/metric.ts`), `renderSparkline` (`components/sparkline.ts`) | `new MetricRow(metrics, options)`; `sparkGlyph(fraction)` | inline metrics / block-glyph sparkline | – |
| `WizardStep` (`components/wizard-step.ts`) | `new WizardStep(options)` | header + body + footer hints | `[ran]` "Setup step N of 5", bold title, muted blurb, footer `↑/↓ select · ⏎ confirm · ⎋ skip · Ctrl+C exit setup` |
| `Form`, `TextFormField`, `SelectFormField` (`components/form.ts`) | – | labelled fields | – |
| `Image` (`components/image.ts`) | kitty/iTerm2 inline images, `ImageBudget` | – | – |
| `FramedMessageComponent` (`chrome/message-frame.ts`) | `Box(1,1, bg customMessageBg)` + bold `customMessageLabel` tag | labelled framed message (extension/custom messages) | filled bubble with tag |
| `MessageDividerComponent` (`chrome/message-divider.ts`) | `{label: () => string, labelColor: ThemeColor, native?}` | "short left-aligned rule and label surrounded by blank transcript rows" | – |
| `OverlayPanel`, `PanelRows`, `PanelDivider` + `topBorder(width,title,color)`, `divider`, `bottomBorder`, `row`, `splitRow` (`chrome/overlay-box.ts`) | `new OverlayPanel(title, role)` | titled box for every overlay | `[ran]` rounded box, title in the top border, hint row at bottom (e.g. `↑↓ navigate · ⏎ confirm · ⎋ close`) |
| `StatusNotice` (`chrome/status-notice.ts`) | `new StatusNotice(message, options)` | one-line notice | – |
| `ToolActivityContainer` (`chrome/tool-activity.ts`) | `new ToolActivityContainer(component|components)` | collapsible tool-activity group (Ctrl+Shift+O) | – |
| `StreamingPanelContent` (`chrome/streaming-panel.ts`) | `new StreamingPanelContent(() => presentation)` | live panel for streaming side output | – |
| `CountdownTimer` (`chrome/countdown-timer.ts`) | `(seconds, tui, onTick(seconds), onDone)` | updates a title like `Title (12s)` | used by approval timeout |
| `formatErrorBlock`, `sanitizeErrorLine` (`chrome/error-block.ts`) | functions | error lines | `[ran]` red `Error: No model selected.` lines on a dark band |
| `keyHint/appKeyHint/rawKeyHint` (`chrome/keybinding-hints.ts`) | functions | `Key description` hints coloured accent/dim | `[ran]` `⇧⇥ to change thinking effort` right-aligned under composer |
| `planContextMap` (`chrome/context-map.ts`) | function | context-window bar using `⛁ ⛃ ⛝ ⛶ ╎ ┃` glyphs | – |
| `ToolCard` (`render/tool-card.ts`) | `new ToolCard(theme, options, build)`; `framedToolCard`, `plainToolCard` | tool call card with phase state | – |
| `renderOutputBlock` (`render/output-block.ts`), `OutputPane` (`render/output-pane.ts`) | `{expanded, collapsedMaxLines, expandedMaxLines, showExpandHint}` | capped output with "expand" hint | – |
| `renderCodeCell`, `renderMarkdownCell` (`render/code-cell.ts`), `renderFileList` (`render/file-list.ts`), `fileUriForTerminal/urlHyperlink` (`render/hyperlink.ts`) | functions | syntax-highlighted code, file lists, OSC 8 links | – |
| Chat: `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, `BashExecutionComponent`, `ReadToolGroupComponent`, `CompactionSummaryMessageComponent`, `TodoReminderComponent`, `TranscriptBrowser`, `ChatTranscriptBuilder` (`chat/*.ts`) | built by the coding agent's `InteractiveMode` from session events | transcript entries (see Q3) | – |
| Overlays: `ApprovalDialogComponent(prompt, callbacks, options)`, `AskDialogComponent`, `ModelPickerComponent`, `PlanReviewOverlay`, `SessionSelectorComponent`, `ThemeSelectorComponent(…) extends OverlayPanel`, `SettingsSelectorComponent`, `ContextViewer`, usage dashboard, jobs panel, agents hub, rewind selector, history search (`overlays/*.ts`) | see Q8 for approval | – | `[ran]` settings/model pickers are full-width panels with a `TabBar` header |

`[ran]` Component look in the running TUI: the whole UI is flat (no heavy borders) except overlays; accent `#00b4ff` (titanium) is used for the cursor row, selected tab, tab/section titles and key hints; muted grey for descriptions.

## Q3. Message layout

`[source]` `chat/user-message.ts`: user turns are a **filled bubble** — `Box` with `theme.bg("userMessageBg")`, one top padding row carrying a left `*` accent marker when the message was a live steer and a right-aligned reaction badge; text colour `userMessageText` (`""` = terminal default). `CollapsedSyntheticMessageComponent` folds synthetic messages to one dim summary line. `[ran]` the echoed `/theme` and `/help` entries appear as full-width dark bands (`userMessageBg #0f1216` on titanium) with one blank row above/below.
`[source]` `chat/assistant-message.ts`: assistant text is rendered with `Markdown` in `assistantMessageText` (optional token; default = terminal fg), no prefix glyph or left rule; thinking header is `<thinkingText glyph> Thinking · <tokens>` with a streaming rate span in truecolor; thinking text is `thinkingText` colour and collapsed unless `Ctrl+T` toggles; error text `theme.fg("error", "Error: …")`; images as `[Image: mime]` links.
`[source]` `chat/tool-execution.ts` (2022 lines): a tool call is a block whose background is `toolPendingBg` while running / `toolSuccessBg` / `toolErrorBg` on result (`bgFill`, line ~1486); header `<bold toolTitle label> · <muted detail> <elapsed>`; the native/compact form draws `╭─ <label>` and `╰` in `dim`. Collapsed output shows `DEFAULT_TERMINAL_PREVIEW_LINES = 10` (`render/render-utils.ts:119`); `Ctrl+O` (`app.tools.expand`) flips `setExpanded` for all cards; `render/output-pane.ts` applies `collapsedMaxLines/expandedMaxLines` through `truncateToVisualLines` (`chrome/visual-truncate.ts`, width-aware so wrapped lines count) and appends an expand hint. `ReadToolGroupComponent` groups consecutive `read` calls ("N more files pending…").
`[docs tui-runtime-internals.md §Viewport allocation and tool collapse]`: the root reserves chrome (editor, status, HUD, overlays) first, gives every *active* block one row, then surplus to newer blocks; `ToolExecutionComponent` degrades 3+ rows → full renderer, 2 rows → folded card, 1 row → label/activity line with a shared-clock pulse, 0 → hidden. Settled transcript rows are **retired into terminal scrollback** (explicit history; `TerminalFramePlan`), so very long output is scrolled by the terminal, not an internal viewport `[docs tui-core-renderer.md §1 Frame ownership]`.
`[source]` dividers: `MessageDividerComponent` draws a short left rule + label between blank rows; `TranscriptNotice`/`TranscriptStatusBlock` for inline notices. `[ran]` the "Update Available" notice is a yellow-bordered band (`─` rules above/below, bold title, body), and warnings are plain yellow text.

## Q4. Diff rendering

`[source]` `chrome/diff.ts` (320 lines): **unified only** (no side-by-side). `renderDiff(diffText, {filePath, theme…})` parses lines of the form `<prefix><lineNum>|<content>`; computes `lineNumberWidth`; removed rows carry old numbers, added rows new numbers, context rows old numbers; `-`/`+`/` ` rows are coloured `toolDiffRemoved` / `toolDiffAdded` / `toolDiffContext`; gap rows render as `…` in `toolDiffContext`; tabs replaced; leading indentation visualised (`visualizeIndent`). **Word-level highlighting**: `renderIntraLineDiff` computes a word diff between a paired removed/added line and renders the changed spans in **inverse video** (`\x1b[7m`) on top of the line colour. Context lines are syntax-highlighted in batch (`highlightContextLines`) so multi-line tokens survive. `nativeDiff()` emits the same structure as a Tern native node. Collapse is not inside `diff.ts`: the surrounding tool card applies the 10-line preview / `Ctrl+O` expansion (Q3). Colour-blind mode shifts `toolDiffAdded` towards blue (Q1).

## Q5. Composer

`[source]` `prompt/composer.ts` (`class Composer implements TerminalFrameProvider, NativeSurfaceProvider`, `ComposerOptions {terminal?, tuiOptions?, preferences?, welcome?, status?, exit?, now?}`): the composer **owns the TUI** in the coding agent — it creates `TUI`, the welcome header, the editor (`prompt/custom-editor.ts extends Editor`) and the status host `[docs tui-runtime-internals.md §Boot and root composition]`.
- **Shapes** `[source]` `components/composer/types.ts` `BUILTIN_EDITOR_BORDER_STYLES = ["box","band","claude","pi","borderless","rule","field","rail"]`; default `composer.shape = "band"` (`coding-agent/src/modes/settings.ts`). `band.ts`: "the full status line sits flush against the terminal's left edge as a filled powerline band … above an unboxed prompt anchored by a single curved `╰─ ` cue" (`defaultPromptGutter: "╰─ "`, `paddingX 0`, `verticalChrome 1`). `[ran]` wizard step 4 labels: `1 Status Band (Default) — Flush soft-capped status band above a curved prompt, no frame`, `2 Rounded Box — Status line embedded in top border, compact 2-line prompt`, `3 Claude Code — Full-width horizontal rules above and below, status line at bottom`, `4 Pi — Framed horizontal rules with status line at bottom`, `5 Borderless — Clean prompt glyph with status line at bottom, no box borders`, `6 Top Rule Dock — Single top rule with status docked onto it and below`, `7 Compact Field — Filled one-row field with accent end caps`, `8 Accent Rail — Filled one-row field anchored by a single accent rail`.
- **Prompt glyph / placeholder** `[ran]`: band shape shows `╰─ ` then the placeholder `Ask anything, edit files, run tools`; the theme preview shows the box shape as `> Ask anything, edit files, run tools` with hint row `⏎ send · ⇧⏎ newline · / commands`. Right-aligned hint under the composer: `⇧⇥ to change thinking effort` (`prompt/composer-hints.ts`, hint ids `agents` ("… to see N running agents") and `effort`).
- **Multi-line editing** `[source]` `components/editor.ts`: full editor with word motions, kill ring, undo; `Shift+Enter`/`Alt+Enter` newline (`[ran]` `/hotkeys` table "Editing: ⏎ Send message · ⇧⏎/Alt+⏎ New line · Ctrl+W/Alt+⌫ Delete word backwards · Ctrl+K Delete to end of line · Ctrl+U Delete to start of line · Alt+L Copy current line · Alt+C Copy whole prompt"; "Navigation: ↑/↓/←/→ Move cursor / browse history (↑ when empty) · Alt+←/→ Move by word · Ctrl+A/Home Start of line · Ctrl+E/End End of line"). `Ctrl+G` opens `$VISUAL/$EDITOR`.
- **Autocomplete kinds** `[source]` `pi-tui/src/autocomplete.ts` + `prompt/*-autocomplete.ts`: `/` slash commands (fuzzy, with descriptions — `[ran]` popup lists `name  description` rows, cursor `❯`, icons per command), `@` file paths (`autocomplete.ts` path scanner), `:` emoji (`emoji-autocomplete.ts`), `#` prompt actions (`prompt-action-autocomplete.ts`), `/skill:` skill tokens (`skill-tokens.ts`), model mentions (`model-mention-autocomplete.ts`, `model-mention-syntax.ts`), GitHub refs (`github-ref-autocomplete.ts`), internal `local://` URLs (`internal-url-autocomplete.ts`), word completion (`word-completion.ts`).
- **Attachments** `[source]` `prompt/attachment-chips.ts`, `composer-attachments.ts`, `image-references.ts`: pasted/dropped images become chips (converted to PNG via `chat/image-loading.ts`); `Ctrl+V` = `app.clipboard.pasteImage` ("image preferred, text fallback"), `Ctrl+Shift+V` raw text paste without collapsing.
- **Queued messages** `[source]` `prompt/queued-messages.ts`, `queue-input.ts`: groups under headings `"Steering"` and `"After yield"`, counter `N queued`, newlines shown as ` ↵ `; keys `Ctrl+Q`/`Ctrl+Enter` = `app.message.followUp`, `Alt+Up`/`Shift+Up` = `app.message.dequeue`; RPC exposes `set_steering_mode all|one-at-a-time`, `set_follow_up_mode`, `set_interrupt_mode immediate|wait` `[docs rpc.md]`.
- **Bracketed paste** `[source]` `terminal.ts`: enables DEC 2004 (`\x1b[?2004h`), queries DECRPM 2004 to confirm; until confirmed `StdinBuffer` uses an unbracketed raw-paste heuristic; disabled on exit. Windows: `win32-input-mode` decoder and AltGr translation (`windows-input-mode.ts`, `windows-altgr.ts`).
- **Vim mode** `[source]` setting `tui.vimMode` default `false` (`modes/settings.ts`); `[docs keybindings.md §Vim editing mode]` normal/visual/replace modes, motions `h j k l 0 ^ $ w b e f F t T gg G % { }`, operators `d y c` with text objects `iw aw i" i( ip …`, `.` repeat, `u` undo, `>>`/`<<`, Escape semantics documented; the status line gains a `vim` segment.
- Magic keywords `[docs magic-keywords.md]` and `tips.txt` rotating tips (`[ran]` "Tip: Type `/` at the start of your prompt to browse every command").

## Q6. Status line

`[source]` `status-line/schema.ts`, `segments.ts`, `presets.ts`, `separators.ts`, `chrome/context-thresholds.ts`:
- Segment ids: `pi, status, model, mode, path, git, pr, subagents, token_total, token_rate, cost, context_pct, context_total, time_spent, time, session, hostname, cache_hit, session_name, collab, stream, vim, usage`. Each segment has a `statusLine*` colour token (Q1).
- Default layout: `left: ["vim","model","mode","path","git","pr"]`, `right: ["session_name","token_total","cost","context_pct"]`; presets `default` (separator `powerline-thin`, model shows thinking level, path abbreviated to 40 chars with work-prefix stripped, git shows branch/staged/unstaged/untracked), `minimal` (`slash` separator), `compact`, `full` (`powerline`, 24h time), `nerd` (nerd icons, seconds), `ascii` (`ascii` separator). Settings: `statusLine.preset` default `default`, `statusLine.separator` default `powerline-thin`, `statusLine.contextLine` default `embedded`; custom segment lists live in `config.yml` (`[docs settings.md]`).
- `[ran]` band status line content with no model, in this repo: `π › ◉ no-model › MARS-Send-Youre-AI-To-Space › main › ⊡ 7.7K/?` and after branching `… › devin/1793674000-ui-research-oh-my-pi ?1 › ⊡ 7.7K/?` (git branch + untracked count update live; `7.7K/?` = tokens / unknown context window). Theme preview sample: `sonnet  ~/project  main +2  42%  0.18`.
- **Context thresholds** `[source]` `chrome/context-thresholds.ts`: levels `normal → warning → purple → error`; `warning` at ≥50 % **or** 150 000 tokens, `purple` at ≥70 % or 270 000, `error` at ≥90 % or 500 000 (whichever threshold is lower for the model's window); `getContextUsageThemeColor(level)` drives `context_pct` colour; the `embedded` context line shows the percentage inside the band.
- `status-line/host.ts`, `loop.ts`, `footer.ts` run the refresh loop; `coding-agent/src/modes/status-line-host.ts` wires session state into `SegmentContext`.

## Q7. Keybindings (defaults)

Config: user remaps in **`~/.omp/agent/keybindings.yml`** (`action-id: "Ctrl+P"` or a list; `[]` disables; legacy `keybindings.json` auto-migrated) `[docs keybindings.md §Customize keybindings; source app-keybindings.ts:431]`. Defaults from `pi-tui/src/app-keybindings.ts` (`defaultKeys`), cross-checked with `docs/keybindings.md` and the `[ran]` `/hotkeys` overlay:

| Action id | Default | Purpose |
|---|---|---|
| `app.interrupt` | `Esc` | Interrupt current operation (double-Esc action configurable: `doubleEscapeAction` default `rewind`) |
| `app.clear` | `Ctrl+C` | Clear prompt / cancel (second press exits) |
| `app.exit` | `Ctrl+D` | Exit |
| `app.suspend` | `Ctrl+Z` | Suspend |
| `tui.input.submit` / newline | `Enter` / `Shift+Enter`, `Alt+Enter` | Send / new line `[ran]` |
| history | `↑` when editor empty; `Ctrl+R` = `app.history.search` | Browse / search prompt history `[ran]` |
| scroll | `PgUp`/`PgDn` inside overlays and approval details `[docs approval-mode.md]`; transcript scrolls via terminal scrollback | |
| `app.tools.expand` | `Ctrl+O` | Toggle tool-output expansion |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O` | Show/hide tool activity |
| `app.thinking.toggle` | `Ctrl+T` | Toggle thinking-block visibility |
| `app.thinking.cycle` | `Shift+Tab` | Cycle thinking level `[ran]` hint `⇧⇥ to change thinking effort` |
| `app.model.cycleForward` / `cycleBackward` | `Ctrl+P` / `Shift+Ctrl+P` | Cycle role models |
| `app.model.select` / `selectTemporary` | `Alt+M` / `Alt+P` | Model picker / temporary model |
| `app.plan.toggle` | `Alt+Shift+P` | Toggle plan mode |
| `app.approval.approve` | `Ctrl+Enter`, `Ctrl+Q` | Approve pending tool call outright (`Esc` denies, `Enter` takes highlighted choice) |
| `app.ask.hide` | `Alt+H` | Hide/show pending `ask` question |
| `app.message.followUp` | `Ctrl+Q`, `Ctrl+Enter` | Queue follow-up while running |
| `app.message.dequeue` | `Alt+Up`, `Shift+Up` | Pull queued message back into editor |
| `app.retry` | `F5`, `Alt+R` | Retry failed turn |
| `app.editor.external` / `app.local.open` | `Ctrl+G` / `Alt+G` | External editor |
| `app.clipboard.copyLine` / `copyPrompt` | `Alt+Shift+L` / `Alt+Shift+C` (`/hotkeys` shows `Alt+L` / `Alt+C` for the editor) | Copy |
| `app.clipboard.pasteImage` / `pasteTextRaw` | `Ctrl+V` (macOS also `Cmd+V`, Windows also `Alt+V`) / `Ctrl+Shift+V`, `Alt+Shift+V` | Paste |
| `app.display.reset` | `Alt+L` | Reset terminal display |
| `app.links.hint` | `Alt+O` | Tag on-screen extension links, type tag to open |
| `app.agents.hub` | `Alt+A` (`Ctrl+S` inside pickers) | Agent hub |
| `app.session.pin` / `unpin` | `Alt+K` / `Alt+Shift+K` | Resume picker |
| session picker keys | `Ctrl+P` path toggle, `Ctrl+S` sort, `Ctrl+R` rename, `Ctrl+D` delete, `Ctrl+Backspace` delete (non-invasive) | |
| `app.stt.pushToTalk` / `app.stt.toggle` / `app.live.toggle` | `Space` (hold) / unbound / `Ctrl+L` | Speech |
| `app.session.new/tree/fork/resume`, `app.tree.previousBranch/nextBranch` | unbound (slash commands `/new /tree /fork /resume`) | |
| rewind | double `Esc` (`doubleEscapeAction: "rewind"`) opens the rewind selector; `/rewind` | |

`[ran]` the `/hotkeys` overlay ("Keyboard Shortcuts") renders three tables — Navigation, Editing, Other — with `PgUp/PgDn scroll · ⎋ to close` footer (screenshot 13).

## Q8. Approvals / permission UI

`[docs approval-mode.md]` (confirmed in `coding-agent/src/tools/approval.ts`, `task/executor.ts` `[source]`):
- Setting `tools.approvalMode` ∈ `always-ask | always-ask-cached | write | yolo`; **default is `yolo`** (auto-approve read/write/exec). `--approval-mode`, `--auto-approve`, `--yolo` override per run. Tool tiers: `read`, `write`, `exec`. `always-ask` prompts for write+exec; `always-ask-cached` ("Ask and remember") also prompts before reading un-granted files and can remember grants ("Remember across sessions" toggle, "Always …" labels). `tools.approval.<tool>: allow|deny|prompt` per-tool user policy; `tools.restrictedFolders` forces prompts even in yolo; `bash.patterns` deny/prompt/allow rules plus built-in critical patterns (`rm -rf /`, fork bombs, fetch-then-execute, `/etc/passwd`, shutdown). Subagents run headless with `tools.approvalMode: yolo`; the parent `task` approval is the boundary.
- **Dialog** `[source]` `overlays/approval-dialog.ts` `ApprovalDialogComponent(prompt, callbacks, options)`: an `OverlayPanel` titled with the prompt's first line (e.g. `Allow tool: <name>`), body = summarised details (one row per detail, `…` when truncated), choice rows, divider, footer; **docked above the composer**. Choices: `Approve` (or `Approve Once` when grants exist), `Approve <tool> for this session`, `Deny`; highlight starts on Approve; arrows move, `Enter` confirms, `Ctrl+Enter`/`Ctrl+Q` approves outright, `Esc` denies, `Ctrl+O` toggles full details (button `Details`/`Less`), `PgUp/PgDn` scroll. `APPROVE_ARM_MS = 500`: Enter/approve are ignored for the first half second so a keystroke meant for the composer cannot answer it. If the composer holds a draft the highlight sits on **`Deny and send message`** (`DENY_AND_SEND_LABEL`) and sending denies all pending approvals and steers the turn. Optional `timeout` shows a `CountdownTimer` in the title `Title (Ns)`. Hosts without a dialog (RPC/ACP) get a select with the same choices.
- `AskDialogComponent` (`overlays/ask-dialog.ts`, 1821 lines) renders the model's `ask` tool questions (options, free-text, multi-question) above the composer; `Alt+H` hides it to one line.
- **Not reached** `[ran]`: without a model no tool call could be triggered, so no approval screenshot exists.

## Q9. Spinners and motion

`[source]` `components/loader.ts`: `DEFAULT_SPINNER_FRAMES = ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, `SPINNER_ADVANCE_MS = 80`, `RENDER_INTERVAL_MS = 1000/30` when the colour function is animated (shimmer). `theme/symbols.ts` provides per-preset frames (status spinner `⣾⣽⣻⢿⡿⣟⣯⣷`; ASCII `|/-\`); themes may override `symbols.spinnerFrames`. `CancellableLoader` exposes an `AbortSignal` and `onAbort` (interrupt key); `BorderedLoader` boxes a loader for overlays; `CountdownTimer(seconds, tui, onTick, onDone)` drives timed titles.
`[source]` `theme/shimmer.ts`: text shimmer for "working" labels with modes `classic | kitt | disabled` (`display.shimmer` default `classic`), 30 cells/s sweep, 3-tier palette (`dim → muted → accent` by default, overridable per theme).
`[source]` settings: `display.smoothStreaming` default `true` (per-character pacing of streamed text), welcome intro animation (composer-owned header, retires when content overflows `[docs tui-runtime-internals]`), `codex-reset-fireworks.ts` easter egg.
**Reduced motion** `[source]`: no TUI-wide reduced-motion setting; the only hooks are `display.shimmer = disabled`, `display.smoothStreaming = false`, and the Tern native `DescribeContext.reduceMotion` flag ("The terminal asked for reduced motion", `native/node.ts:76`) which only affects native surfaces. Screen-reader affordances: none beyond keeping text labels next to pulses (`assistant-message.ts:781` comment) and `transcript-notice.ts`; not verified further.

## Q10. Extension points for a client

- **`pi-tui` public surface** `[source]` `pi-tui/src/index.ts` + `package.json` exports (`.`, `./theme`, `./theme/*`, `./render`, `./chrome`, `./tools`, `./status-line`, `./components/*`, `./native/*`, `./*`): components, `TUI`/`Container`, `ProcessTerminal`/`Terminal`, `terminal-capabilities`, keybindings (`KeybindingsManager`, `matchesKey`, `app-keybindings`), `keys`, theme API, glyph protocol, kitty graphics, native (Tern) rendering, utils (`truncateToWidth`, `visibleWidth`, `replaceTabs`, `wrapText`). Deep imports are allowed by the export map.
- **Building a standalone TUI without the agent loop** `[source tui.ts, terminal.ts; docs tui.md, tui-core-renderer.md]`: `const term = new ProcessTerminal(opts); const tui = new TUI(term, /*showHardwareCursor*/ true); tui.addChild(myRootComponent); tui.setFocus(editor); tui.start({clearScrollback?: boolean, deferInput?: boolean});` — the TUI calls `terminal.start(onInput, onResize)`, probes capabilities (kitty keyboard, DEC modes, OSC 11 background, glyph protocol, Tern hello), enables bracketed paste, and runs the render loop: each frame renders mandatory chrome, asks the root for rows within the viewport remainder, and emits a `TerminalFramePlan`; settled rows are appended to scrollback (history) rather than redrawn. Components implement `render(width)`; `tui.requestRender()` after state change; `tui.showOverlay(component, {anchor, width…})` for modals; `theme.fg/bg` for colours; `getKeybindings().matches(data, "app.interrupt")` / `matchesKey(data, "escape")` for keys; `initThemeSync()` or `setTheme()` before first render. Rendering rules: never exceed `width` visible cells, no raw `\n`, strip/replace tabs, reset SGR per line `[docs tui.md §Rendering constraints]`. The coding agent's own `Composer` (`prompt/composer.ts`) is the reference root that does exactly this (`ComposerOptions.terminal`, `tuiOptions`).
- **Coding-agent modes** `[source coding-agent/src/modes/]`: `interactive-mode.ts` (full TUI; builds `new Composer({...})`, `TranscriptContainer`, overlays), `print-mode.ts` (`-p`, text/json), `rpc/` (`--mode rpc` / `rpc-ui`), `acp/` (`omp acp`, Agent Client Protocol), `setup.ts` (wizard), `status-line-host.ts`, `agent-hub-runtime.ts`. CLI flags `[ran --help]`: `--mode text|json|rpc|rpc-ui`, `--no-ui`, `-p`, `--approval-mode`, `--auto-approve`, `--thinking`, `--max-cost`, `--warn-cost`, `--max-time`, `--profile`, `--config`, `--hook`, `-e/--extension`, `--no-extensions`, `--no-skills`, `--tools`, `--export`.
- **RPC protocol** `[docs rpc.md]`: `omp --mode rpc` speaks **JSONL over stdin/stdout**: a `ready` frame first (protocol versions, transport limits), then commands `{id?, type, …}` → responses `{id, type:"response", command, success, data|error}` + events. Commands include `prompt {message, images?, streamingBehavior: "steer"|"followUp"}`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `get_state`, `set_model {provider, modelId}`, `cycle_model`, `get_available_models`, `set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`, `compact`, `set_auto_compaction`, `bash {command}`, `new_session`, `open_session`, `switch_session`, `fork`, `branch`, `navigate_tree`, `get_entries`, `get_tree`, `set_todos`, `goal`, `set_host_tools` (host-provided tools), `set_host_uri_schemes`, `set_ask_dialog`, `set_subagent_subscription off|progress|events`, `get_subagents`, `steer_subagent`, `cancel_subagent`, `export_html`, `negotiate_protocol {protocolVersion: 2}`, login flow. Events mirror `AgentSession` events (`message_update` with `text_delta`, tool start/end, `queue_update`, progress, cache warming) and an **Extension UI sub-protocol** lets the host answer dialogs (approval select, ask). Types in `coding-agent/src/modes/rpc/rpc-types.ts`; `rpc-client.ts` is a reference client. **Assessment**: this is a complete desktop-client protocol (model/thinking/queue/approval/subagent control); MARS does not need it since it embeds `createAgentSession` directly, but its command/event vocabulary is a good checklist for the workbench RPC.
- **SDK** `[docs sdk.md; source coding-agent/src/sdk.ts]`: `createAgentSession({authStorage, modelRegistry, settings: Settings.isolated({...}), sessionManager: SessionManager.inMemory(), toolNames, restrictToolNames, enableMCP, enableLsp, hasUI, …}) → { session, modelFallbackMessage }`; `session.subscribe(event => …)`, `session.prompt(text)`, `session.dispose()`. With `hasUI: false` extension dialogs resolve to defaults and tool `ask`/approval must be answered by the host.
- **Extensibility** `[docs extensions.md, hooks.md, skills.md, slash-command-internals.md]`: extensions are TS modules `export default function (pi: ExtensionAPI)`, registering commands (`pi.registerCommand(name, {description, handler(args, ctx)})`), tools, hooks, messages; `ctx.ui.custom(factory(tui, theme, keybindings, done))` mounts any `pi-tui` component as an overlay; `ctx.ui.notify`, `ctx.ui.select`, `ctx.hasUI`. Hooks file via `--hook`. Skills are `SKILL.md` folders discovered from `~/.omp/agent/skills` and project dirs. Slash commands registered in `coding-agent/src/slash-commands/builtin-*.ts` `[source]`: `help hotkeys model theme settings setup login logout compact context copy export fork tree resume new session rename retry plan plan-review goal todo tools skills mcp agents hub jobs live btw usage stats status thinking effort fast slow ultra vibe memory cleanse collab join leave share ssh update changelog handoff rewind local` and more (≈170 names incl. sub-commands). Plan mode (`coding-agent/src/plan-mode/`, `Alt+Shift+P`, `--plan-yolo`), tasks/subagents (`task/`, `docs/task-agent-discovery.md`), compaction (`docs/compaction.md`).

## Q11. Terminal compatibility

`[source]` `terminal-capabilities.ts`: `TerminalId` detected from env (`TERM_PROGRAM`, `KITTY_WINDOW_ID`, `WT_SESSION`, …); `RuntimeTerminal {trueColor, imageProtocol: "kitty"|"iterm2"|"sixel"|null, hyperlinks, deccara (rectangular SGR), supportsScreenToScrollback, textSizing, styledUnderlines, glyphProtocol}`; env overrides `PI_FORCE_IMAGE_PROTOCOL`, hyperlink/synchronized-output overrides, `isSshSession()`. Images: kitty graphics (`kitty-graphics.ts`) and iTerm2 inline; **SIXEL only as passthrough** of model/tool output when both `PI_FORCE_IMAGE_PROTOCOL=sixel` and `PI_ALLOW_SIXEL_PASSTHROUGH=1` (`render/sixel.ts`), with a Windows Terminal Preview sixel check. Synchronized output (DEC 2026) on by default where supported. Multiplexers `multiplexers/{tmux,screen,zellij,cmux,wmux,orca,herdr}.ts`: tmux gets DCS passthrough wrapping (`\x1bPtmux;…\x1b\\`) for OSC notifications, OSC 8 hyperlinks forwarded on tmux ≥ 3.4, OSC 11 background query trusted only when the multiplexer allows. Windows: ConPTY write chunking (`chunkForConPTY`), `Win32InputModeDecoder`, AltGr translation, UTF-8 codepage re-assert, `\x1b[?9001l` on exit. Resize: `ResizeScrollbackMode = append|rebuild|preserve` (`setResizeScrollback`), `Alt+L` full display reset. **Minimum size**: no global guard found — only overlay `minWidth`; components truncate to width (not verified beyond grep). Accessibility: see Q9 (no screen-reader mode; `reduceMotion` only for Tern native surfaces). Native "Tern Surface Protocol" rendering (`native/`, `docs/tui-core-renderer.md §Native rendering`) lets the Tern terminal draw components as widgets (buttons, clickable approvals).

## Q12. Design judgement vs Claude Code / Codex

Observed `[ran]` Oh My Pi traits: (1) **density** — no left gutter glyphs or indented transcript; user turns are full-width filled bands, assistant prose flush-left, tool cards are tinted blocks with a bold title line; (2) **colour** — one strong accent (`#00b4ff` on titanium) for cursor rows, titles, key hints and the status band; backgrounds are near-black tints (`#151820/#0f1216`) rather than borders; errors are red text on a dark band, warnings plain yellow; (3) **glyphs** — braille spinners, `╰─` prompt cue, powerline-thin separators `›`, `◉`/`⊡` status icons, `❯` list cursor, rounded `╭╮╰╯` overlay boxes, optional Nerd Font set delivered in-band; (4) **motion** — shimmer on working labels, 80 ms spinner, smooth streaming; (5) **status band above the prompt** instead of a footer, with git branch/untracked count live; (6) **overlays** are full-width tabbed panels (`Appearance | Model | Interaction | Context | Memory | Files`) with inline value cycling and live preview; (7) the composer shape, glyph preset and theme are the user's first three decisions (setup wizard), and one of the shapes is literally named `Claude Code` ("full-width horizontal rules above and below, status line at bottom").
Claude Code / Codex conventions (from general familiarity, **not verified** in this study): bordered or rule-framed prompt at the bottom, status/footer below the prompt, `⏺`/`●` bullets per turn, collapsed tool lines with `⎿` continuation, mostly default-fg text with a single accent, approval as a three-option list `Yes / Yes, and don't ask again / No` with number keys. Oh My Pi differs mainly in the *top* status band, tinted blocks instead of bullets/rules, the live-preview wizard, and much richer glyph/theme/shape configurability.
**Keep verbatim for "native feel"**: the `titanium` palette and token names; `band` composer with `╰─ ` cue and the placeholder `Ask anything, edit files, run tools`; `OverlayPanel` boxes with title-in-border and `↑↓ navigate · ⏎ confirm · ⎋ close` footers; `SelectList` `❯` cursor + "Type to search"; `TabBar` filled selected tab; braille spinners at 80 ms; tool-card tinting by `toolPendingBg/toolSuccessBg/toolErrorBg`; unified diff with inverse-video intraline changes; the context-usage colour thresholds; the key-hint format `accent key + dim italic label`; symbol presets with ASCII fallback.

## Patterns worth borrowing

| Pattern | Rule it embodies | What a MARS builder does |
|---|---|---|
| Semantic colour tokens + `vars` indirection (`ThemeJson`) | Components never see hex; themes stay small and swappable | Import `pi-tui/theme`, ship a `mars.json` theme in the same schema (dark+light), call `theme.fg(token)` only |
| Three symbol presets with ASCII fallback + in-band glyph upload | Every glyph must have a plain fallback; nerd icons are opt-in | Use `theme.sym`/`theme.icon` everywhere; never hard-code `✔`; expose `symbolPreset` in MARS settings |
| Settled transcript rows retire to terminal scrollback; viewport only holds live chrome | Users keep native scrollback/search/copy; the app never fights the terminal | Build on `TUI` + a `TerminalFrameProvider`/`TranscriptContainer`-style root rather than a custom alt-screen scroll view |
| Tool cards tinted by state, 10-line preview, one global `Ctrl+O` expand, graceful 3/2/1/0-row degradation | Pending/success/error legible at a glance; long output never floods | Reuse `ToolCard`/`renderOutputBlock` with `collapsedMaxLines=10`; map MARS run states to `toolPending/Success/ErrorBg` |
| Unified diff with line numbers + inverse intraline highlight | Shows exactly what changed without a side-by-side width budget | Call `renderDiff()` from `pi-tui/chrome` for MARS proposals/patches |
| Approval dialog docked above composer, 500 ms arm delay, "Deny and send message" when a draft exists | Prevent accidental approval; make refusal a steering act | Keep these three behaviours in MARS's confirmation UI for follow-up proposals |
| Context usage traffic light (50/70/90 % or 150k/270k/500k) | Warn before compaction becomes forced | Reuse `getContextUsageLevel` for the MARS context segment |
| Status band above prompt with model · cwd · git · tokens · cost · context | One glance answers "which model, where, how much" | Compose MARS's band from `status-line/segments.ts` ids; add a `sandbox`/`budget` segment |
| Setup wizard with live preview (glyphs, composer shape, theme) | First-run choices should be visible before commit | Reuse `WizardStep` + `previewTheme` for MARS onboarding (sandbox approval, free-model choice) |
| Key hints rendered from the live keybinding map (`appKeyHint`) | Hints never drift from bindings; remaps stay discoverable | Use `KeybindingsManager` + `keybindings.yml`-style file for MARS; render hints with `appKeyHint` |
| Fuzzy slash-command popup with description column | Discoverability without a manual | Register MARS commands in the same autocomplete provider shape |
| Queued steering / follow-up messages shown under the composer | Users can type ahead without interrupting | Expose MARS workbench "steer" and "follow-up" queues with `queued-messages.ts` |

## Do not borrow / conflicts

- **`tools.approvalMode` default `yolo`** and `--auto-approve`: MARS requires every follow-up action to be a user-confirmed proposal and execution only inside an approved sandbox. The MARS client must run the embedded session with `always-ask` semantics (or MARS's own gate) and must not expose a YOLO toggle; the `Approve <tool> for this session` choice should be dropped or scoped to the sandbox.
- **Subagents run headless in `yolo`** (`task/executor.ts` pins `tools.approvalMode: "yolo"`): conflicts with MARS's single-runtime, sandbox-only execution; do not surface `/agents`, the Agent Hub (`Alt+A`), or `set_subagent_subscription` in the MARS client.
- **Provider sign-in wizard and model picker that lists paid subscriptions first** (`[ran]` step 1 lists ChatGPT Plus/Pro, Anthropic Pro/Max, …; `/model` lists `local`, `openrouter`, `openai`, `anthropic`, … with `free` tags only on local/some entries): MARS is free-models-first with explicit consent for paid ones — reorder/filter the picker and add a consent step before any paid provider is selectable; hide `/login` for paid providers unless consented.
- **Cost/usage segments assume spend is acceptable**: MARS should show a budget cap (`--max-cost` style) and block, not merely warn.
- **Model output rendered with OSC 8 hyperlinks, `Alt+O` link activation, `/open` in browser, `local://` editing, extension `custom()` overlays and host tools**: model output is untrusted in MARS — keep hyperlinks display-only or route through a confirmation, and do not let model-driven extensions mount UI.
- **Direct shell (`/bash`, `!`), `bash` RPC command, PTY interactive bash, `/ssh`, `/git` UI, Python REPL**: all execute on the host; MARS executes only in the approved sandbox.
- **Speech (`Space` push-to-talk, `/live`), collab/share (`/share`, QR codes), marketplace/plugins, `omp update` self-updater, telemetry export**: out of scope for a thin workbench client and several send data off-host.
- **`~/.omp` config/profiles, `keybindings.yml`, `config.yml` hot reload**: MARS should keep its own config root (do not read or write the user's `~/.omp`).
- **Composer owns the `TUI` and the agent session** (`prompt/composer.ts`): MARS should instantiate `TUI`/components itself and feed them from workbench RPC events, not embed `Composer`/`InteractiveMode`.

## Evidence appendix

**Commands run** (cwd `~/repos/MARS-Send-Youre-AI-To-Space`, Bun 1.4.4):
```
bun node_modules/.bun/@oh-my-pi+pi-coding-agent@18.14.0+*/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts --help      # printed "omp v18.14.0" flag list
bun node_modules/.bun/@oh-my-pi+pi-coding-agent@18.14.0+*/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts --version   # omp/18.14.0
sudo apt-get install -y xterm pngquant
DISPLAY=:0 xterm -fa 'DejaVu Sans Mono' -fs 13 -geometry 120x40 -e bash -c 'export COLORTERM=truecolor TERM=xterm-256color; bun …/src/cli.ts'
# interaction via xdotool: Esc ×5 through wizard; typed /theme ⏎, /settings ⏎, → , /model ⏎, /help ⏎, /hotkeys ⏎, Esc
import -window root …png ; convert -crop 2560x1745+0+0 -resize 60% ; pngquant --quality 60-85
gh api repos/can1357/oh-my-pi/git/trees/31147f9d…?recursive=1 ; curl raw.githubusercontent.com/can1357/oh-my-pi/31147f9d…/docs/*.md
```
What happened `[ran]`: no `~/.omp` existed, so the wizard ran (5 steps, all skipped with `⎋`). Main screen showed the `π omp v18.14.0` splash, the warning `No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.` and an `Update Available — New version 18.16.0 is available. Run: omp update` notice (so 18.14.0 is not the latest). `/settings`, `/model`, `/hotkeys` opened overlays. Typing `/theme` and `/help` followed by Enter was **submitted as a prompt** (the fuzzy popup showed `handoff, plan-review, guided-goal, ratchet, open, agents, git, local, pin, rename` instead of `theme`/`help`) and produced `Error: No model selected. Use /login, set an API key environment variable, or create /home/ubuntu/.omp/agent/agent.db. Then use /model to select a model.`; Tab-accepting the popup ran `/handoff` ("Nothing to hand off"). Cause not verified (possibly xdotool typing racing the popup); `/theme` and `/help` are therefore documented from source/docs only. Approval dialog not reachable without a model.

**Versions**: `@oh-my-pi/pi-coding-agent@18.14.0`, `@oh-my-pi/pi-tui@18.14.0` (installed; `sources/manifest.json` records audited rev `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611`, npm rev `31147f9d1a76608549821c3759f8487b4d66c72d`); xterm 372 (Ubuntu 22.04), Bun 1.4.4.

**Source links (all at `31147f9d1a76608549821c3759f8487b4d66c72d`)**: `packages/tui/src/theme/{schema.ts,theme.ts,theme-class.ts,loader.ts,color.ts,dark.json,light.json,defaults.json,symbols.ts,shimmer.ts,session-color.ts,glyph-bundle.json}`, `packages/tui/src/{tui.ts,terminal.ts,terminal-capabilities.ts,glyph-protocol.ts,app-keybindings.ts,keybindings.ts,keys.ts,autocomplete.ts,index.ts}`, `packages/tui/src/components/{box,editor,select-list,settings-list,tab-bar,table,tree-view,scroll-view,markdown,loader,cancellable-loader,progress-bar,disclosure,key-value-list,metric,sparkline,wizard-step}.ts`, `packages/tui/src/components/composer/{types,band,registry}.ts`, `packages/tui/src/chrome/{diff,message-frame,message-divider,overlay-box,status-notice,tool-activity,streaming-panel,error-block,keybinding-hints,context-thresholds,visual-truncate,countdown-timer}.ts`, `packages/tui/src/chat/{user-message,assistant-message,tool-execution,thinking-display,read-tool-group}.ts`, `packages/tui/src/render/{tool-card,output-block,output-pane,render-utils,code-cell,file-list,hyperlink,sixel}.ts`, `packages/tui/src/overlays/{approval-dialog,ask-dialog,theme-selector,settings-selector,model-picker,bordered-loader}.ts`, `packages/tui/src/status-line/{schema,segments,presets,separators}.ts`, `packages/tui/src/prompt/{composer,composer-hints,queued-messages,attachment-chips,emoji-autocomplete,prompt-action-autocomplete,skill-tokens}.ts`, `packages/tui/src/multiplexers/tmux.ts`, `packages/tui/src/native/node.ts`; `packages/coding-agent/src/{cli.ts,sdk.ts,modes/settings.ts,modes/interactive-mode.ts,modes/rpc/rpc-types.ts,modes/rpc/rpc-mode.ts,modes/status-line-host.ts,tools/approval.ts,task/executor.ts,slash-commands/*.ts}`; `docs/{theme,keybindings,settings,approval-mode,rpc,sdk,tui,tui-core-renderer,tui-runtime-internals,hooks,extensions,skills,compaction,task-agent-discovery,slash-command-internals,cli-reference,magic-keywords}.md`; `LICENSE`. Caveat: paths were read from the installed npm package (`packages/*/src` layout inferred from `docs/rpc.md`); line numbers refer to installed files.

**Screenshots** (xterm, titanium theme, 60 % scale, all < 160 KB, total ≈ 1.3 MB):
1. `01-wizard-step1-providers.png` — Setup step 1 of 5 "Sign in to your providers", provider `SelectList`, footer hints.
2. `02-wizard-step2-default-model.png` — Step 2 "Choose your default model", `No models available in this scope`.
3. `03-wizard-step3-glyph-mode.png` — Step 3 "Choose glyph mode": Nerd Font / Unicode / ASCII sample rows.
4. `04-wizard-step4-composer-shape.png` — Step 4 "Choose composer shape" with live preview and 8 shapes.
5. `05-wizard-step5-theme.png` — Step 5 "Pick a theme" with status-line/editor preview and theme list.
6. `06-main-screen-no-model.png` — Main screen: splash, tip, no-model warning, update notice, status band + `╰─` prompt.
7. `07-slash-command-autocomplete.png` — Slash-command fuzzy popup (name + description columns, `❯` cursor).
8. `08-theme-selector.png` — Result of `/theme ⏎` in this run: echoed command band + `Error: No model selected.` (selector not opened).
9. `09-settings-appearance.png` — `/settings` overlay, Appearance tab: Theme / Composer / Status Line / Display / Images groups with values.
10. `10-settings-second-tab.png` — `/settings` Model tab (Thinking, Sampling, Prompt, Retry & Fallback, Advisor, Prewalk, Vision).
11. `11-model-picker-no-models.png` — `/model` picker: roles sidebar (`local`, `web`, providers) and model list with `free` tags.
12. `12-help-overlay.png` — Result of `/help ⏎` in this run (same no-model error) — help overlay not opened.
13. `13-hotkeys-overlay.png` — `/hotkeys` "Keyboard Shortcuts" overlay: Navigation / Editing / Other tables.
