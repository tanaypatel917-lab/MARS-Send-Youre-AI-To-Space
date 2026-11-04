import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processOutput, renderTerminal } from "@mars/output-format";
import type { ColourDepth, GlyphPreset } from "@mars/ui-core";
import { SLASH_COMMANDS } from "@mars/ui-core";
import { FIXTURE_ROOT, FIXTURE_TASK_ID } from "@mars/ui-core/testing";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { SessionView } from "./app";
import { READ_METHODS, SessionClient } from "./client";
import { SessionController } from "./controller";
import { FINAL_TEXT, type FixtureOptions, fixtureWorkbench } from "./fixture";
import { measure } from "./perf";
import { initialState, renderScreen, type SessionState } from "./screen";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text: string) => text.replace(ANSI, "");

async function session(
  options: FixtureOptions = {},
  state: Partial<SessionState> = {},
) {
  const workbench = fixtureWorkbench(options);
  const writes: string[] = [];
  const controller = new SessionController(
    new SessionClient(workbench.transport),
    initialState(state),
    () => {},
    {
      now: () => NOW,
      width: () => 120,
      writeFile: async (path) => {
        writes.push(path);
      },
    },
  );
  await controller.connect();
  return { workbench, controller, state: controller.state, writes };
}

describe("mars session is read-only", () => {
  test("every request across connect, polling and every slash command is a read method", async () => {
    const { workbench, controller, state } = await session();
    await controller.refresh();
    for (const command of SLASH_COMMANDS) {
      if (command.name === "quit") continue;
      await controller.command(`/${command.name}`);
      state.overlay = null;
    }
    await controller.command(`/resume ${FIXTURE_TASK_ID}`);
    const view = new SessionView(
      state,
      controller,
      () => 40,
      () => {},
      () => {},
    );
    for (const key of [
      "\r",
      "\x1b",
      "\x0f",
      "\x14",
      "?",
      "/",
      "x",
      "\r",
      "\x1b[5~",
      "\x1b[6~",
    ])
      await view.handle(key);
    const methods = new Set(workbench.sent.map((body) => body.method));
    expect(
      [...methods].every((method) =>
        (READ_METHODS as readonly string[]).includes(method),
      ),
    ).toBe(true);
    for (const forbidden of [
      "tasks.start",
      "tasks.steer",
      "tasks.cancel",
      "tasks.approve",
      "tasks.review",
    ])
      expect(methods.has(forbidden as never)).toBe(false);
    expect(methods.has("tasks.journal")).toBe(true);
  });

  test("staged commands say so instead of acting", async () => {
    const { controller, state } = await session();
    for (const name of [
      "new",
      "cancel",
      "approve",
      "undo",
      "permissions",
      "queue",
      "drop",
    ]) {
      await controller.command(`/${name}`);
      expect(state.notice).toContain("not available in this read-only client");
      expect(state.overlay).toBeNull();
    }
  });

  test("/export writes the projection locally and executes nothing", async () => {
    const { controller, state, writes } = await session();
    await controller.command("/export out.md");
    expect(writes).toEqual(["out.md"]);
    expect(state.notice).toContain("nothing was executed");
  });

  test("journal text renders when the host supports tasks.journal", async () => {
    const { state } = await session();
    expect(state.projection?.journal).toBe("available");
    expect(
      state.projection?.entries.some((entry) => entry.kind === "assistant"),
    ).toBe(true);
  });

  test("method not available degrades to turn markers", async () => {
    const { state, workbench } = await session({ journal: "unavailable" });
    expect(state.projection?.journal).toBe("unavailable");
    expect(
      state.projection?.entries.some((entry) => entry.kind === "turn"),
    ).toBe(true);
    const asked = workbench.sent.filter(
      (body) => body.method === "tasks.journal",
    ).length;
    expect(asked).toBe(1);
  });

  test("Esc only closes overlays", async () => {
    const { controller, state } = await session();
    const view = new SessionView(
      state,
      controller,
      () => 40,
      () => {},
      () => {},
    );
    await view.handle("\x1b");
    expect(state.overlay).toBeNull();
    await controller.command("/graph");
    expect(state.overlay?.title).toContain("graph");
    await view.handle("\x1b");
    expect(state.overlay).toBeNull();
  });
});

describe("§2.11 read-only views over fixtures", () => {
  test("graph, proposals, model and context carry the required wording", async () => {
    const { controller, state } = await session({}, { depth: "none" });
    const text = async (command: string) => {
      await controller.command(command);
      return plain(state.overlay?.lines.join("\n") ?? "");
    };
    const graph = await text("/graph");
    expect(graph).toContain("process-level confinement, not a kernel sandbox");
    expect(graph).toContain("model requests 0");
    const proposals = await text("/proposals");
    expect(proposals).toContain("mars vault import --accept");
    expect(proposals).toContain("revision");
    const model = await text("/model");
    expect(model).toContain("capabilities: unknown");
    expect(model).toContain("unavailable · terms");
    expect(model).toContain("stale");
    const context = await text("/context");
    expect(context).toContain("$ —");
    expect(context).toContain("/new");
    expect(context).not.toContain("/clear");
  });
});

describe("output-format agreement", () => {
  test("the assistant card shows the same visible text as renderTerminal", async () => {
    const { state } = await session({}, { depth: "none" });
    const screen = plain(renderScreen(state, 120, 40).join("\n"));
    const expected = renderTerminal(
      processOutput(FINAL_TEXT, { connector_ids: [], allowed_addresses: [] })
        .document,
      { width: 118, errors: [] },
    );
    for (const line of plain(expected)
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean))
      expect(screen).toContain(line);
  });
});

const SIZES = [
  [60, 16],
  [80, 24],
  [120, 40],
  [200, 50],
] as const;
const DEPTHS: ColourDepth[] = ["truecolor", "256", "16", "none"];
const GLYPHS: GlyphPreset[] = ["unicode", "ascii"];
const SNAPSHOTS = join(FIXTURE_ROOT, "snapshots");
const update = process.env.MARS_UPDATE_SNAPSHOTS === "1";

describe("§8 snapshot matrix", () => {
  test("every size × colour depth × glyph preset is byte-exact", async () => {
    if (update) mkdirSync(SNAPSHOTS, { recursive: true });
    for (const depth of DEPTHS)
      for (const preset of GLYPHS) {
        const { state } = await session({}, { depth, glyphs: preset });
        const tool = state.projection?.entries.find(
          (entry) => entry.kind === "tool",
        );
        if (tool) state.expanded.add(tool.id);
        for (const [width, height] of SIZES) {
          const frame = renderScreen(state, width, height);
          expect(frame.length).toBe(height);
          for (const row of frame) expect(visibleWidth(row)).toBe(width);
          const name = `${width}x${height}-${depth === "none" ? "no-color" : depth}-${preset}.ans`;
          const bytes = `${frame.join("\n")}\n`;
          const file = join(SNAPSHOTS, name);
          if (update || !existsSync(file)) writeFileSync(file, bytes);
          expect(bytes).toBe(readFileSync(file, "utf8"));
          if (depth === "none")
            expect(bytes).not.toContain(String.fromCharCode(27));
        }
      }
  });

  test("below 60×16 the client asks for a larger terminal", async () => {
    const { state } = await session();
    expect(plain(renderScreen(state, 50, 12).join("\n"))).toContain("60×16");
  });
});

describe("§8.1 budgets (fixture, 10,000 events)", () => {
  test("first frame ≤ 150 ms, frames ≤ 16 ms, idle CPU < 1 %, client memory ≤ 150 MB", async () => {
    const result = await measure();
    expect(result.events).toBe(10_000);
    expect(result.entries).toBeLessThanOrEqual(2_001);
    expect(result.first_frame_ms).toBeLessThanOrEqual(150);
    expect(result.frame_max_ms).toBeLessThanOrEqual(16);
    expect(result.idle_cpu_ratio).toBeLessThan(0.01);
    expect(result.rss_delta_mb).toBeLessThanOrEqual(150);
  }, 30_000);
});
