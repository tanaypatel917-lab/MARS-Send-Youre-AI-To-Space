import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWorkbench } from "@mars/workbench";
import { buildShell } from "../scripts/build";
import {
  createFixtureOperations,
  type FixtureData,
} from "../scripts/fixture-workbench";
import { BRIDGE_METHODS } from "../src/shared/methods";
import { TEAM_CHAT_METHODS } from "../src/shared/team-chat";

const ELECTRON_BIN = decodeURIComponent(
  new URL("../node_modules/electron/dist/electron", import.meta.url).pathname,
);
const HAS_ELECTRON = existsSync(ELECTRON_BIN);
const HAS_XVFB = process.platform === "linux" && Bun.which("xvfb-run") !== null;
const CAN_RUN_ELECTRON_XVFB = HAS_ELECTRON && HAS_XVFB;
/** CI sets this so a missing Electron binary or Xvfb fails instead of skipping. */
const REQUIRE_ELECTRON_XVFB = process.env.MARS_REQUIRE_ELECTRON_XVFB === "1";
const PACKAGED_ELECTRON = process.env.MARS_PACKAGED_ELECTRON;

test.skipIf(!CAN_RUN_ELECTRON_XVFB)(
  "a crashed renderer recovers in the same window and a crash loop stops on a static page",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "mars-shell-crash-"));
    try {
      const dist = join(home, "dist");
      const entry = join(dist, "crash-renderer.cjs");
      await buildShell(dist);
      await copyFile(
        new URL("./fixtures/crash-renderer.cjs", import.meta.url),
        entry,
      );
      const child = Bun.spawn(
        ["xvfb-run", "-a", ELECTRON_BIN, entry, "--disable-gpu"],
        {
          env: {
            ...process.env,
            HOME: home,
            ELECTRON_ENABLE_LOGGING: "1",
            MARS_SHELL_CONNECTION: join(home, "not-connected"),
          },
          stderr: "pipe",
        },
      );
      const [exit, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`Electron exited ${exit}: ${stderr}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!REQUIRE_ELECTRON_XVFB)(
  "Electron binary and xvfb-run are present when required",
  () => {
    expect({ electron: HAS_ELECTRON, xvfb: HAS_XVFB }).toEqual({
      electron: true,
      xvfb: true,
    });
  },
);

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

class CdpProtocolError extends Error {
  readonly code: number | undefined;

  constructor(error: { code?: number; message?: string }) {
    super(error.message ?? "CDP error");
    this.code = error.code;
  }
}

class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const parsed = JSON.parse(raw) as {
        id?: number;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (typeof parsed.id !== "number") return;
      const entry = this.pending.get(parsed.id);
      if (!entry) return;
      this.pending.delete(parsed.id);
      if (parsed.error) entry.reject(new CdpProtocolError(parsed.error));
      else entry.resolve(parsed.result);
    });
    ws.addEventListener("close", () => {
      for (const entry of this.pending.values())
        entry.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error("CDP WebSocket failed")),
        { once: true },
      );
    });
    return new CdpClient(ws);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "Renderer evaluation threw an exception",
      );
    }
    return response.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function waitForPageTarget(
  port: number,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = (await response.json()) as CdpTarget[];
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            target.url?.startsWith("mars-shell://app/") &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Retry until DevTools endpoint starts listening.
    }
    await Bun.sleep(150);
  }
  throw new Error(
    `Timed out waiting for mars-shell://app page on CDP port ${port}`,
  );
}

async function waitForCondition(
  cdp: Pick<CdpClient, "evaluate">,
  expression: string,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  // The target can appear in /json before Chromium creates its main context.
  // Retry read-only probes, never actions like button clicks.
  const read = async <T>(probe: string): Promise<T | undefined> => {
    try {
      return await cdp.evaluate<T>(probe);
    } catch (error) {
      if (
        error instanceof CdpProtocolError &&
        error.code === -32000 &&
        error.message === "Cannot find default execution context"
      )
        return undefined;
      throw error;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await read<boolean>(expression);
    if (matched) return;
    await Bun.sleep(100);
  }
  const snapshot = await read<string>(
    "document.body ? document.body.textContent.slice(0, 800) : ''",
  );
  throw new Error(
    `Timed out waiting for ${description}. Body snapshot: ${snapshot ?? "(renderer context unavailable)"}`,
  );
}

test("readiness polling retries when CDP has not created the default context", async () => {
  let attempts = 0;
  await waitForCondition(
    {
      async evaluate<T>() {
        if (++attempts === 1)
          throw new CdpProtocolError({
            code: -32000,
            message: "Cannot find default execution context",
          });
        return true as T;
      },
    },
    "true",
    "the renderer",
  );
  expect(attempts).toBe(2);
});

test("readiness polling does not retry renderer exceptions", async () => {
  const exception = new Error("Cannot find default execution context");
  let attempts = 0;
  await expect(
    waitForCondition(
      {
        async evaluate() {
          attempts++;
          throw exception;
        },
      },
      "true",
      "the renderer",
    ),
  ).rejects.toBe(exception);
  expect(attempts).toBe(1);
});

test.skipIf(!PACKAGED_ELECTRON)(
  "installed MARS opens its own workbench and Team Chat without a connection file",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "mars-installed-"));
    const port = await freePort();
    const electronProc = spawn(
      "xvfb-run",
      [
        "-a",
        PACKAGED_ELECTRON as string,
        `--remote-debugging-port=${port}`,
        "--disable-gpu",
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          MARS_SHELL_CONNECTION: "",
        },
      },
    );
    let cdp: CdpClient | undefined;
    const exited = new Promise<number | null>((resolve) => {
      electronProc.once("exit", resolve);
    });
    try {
      cdp = await CdpClient.connect(await waitForPageTarget(port));
      await waitForCondition(
        cdp,
        "document.querySelector('.status-bar > span')?.textContent === 'Workbench online'",
        "the bundled workbench to connect",
        20_000,
      );
      const describe = await cdp.evaluate<{
        ok: boolean;
        result?: { workspaceLabel: string };
      }>("window.marsWorkbench['workbench.describe']({})");
      expect(describe.ok).toBe(true);
      expect(describe.result?.workspaceLabel).toBe("demo-project");
      expect(
        await cdp.evaluate(
          "window.marsExtensions.list().then(entries => Object.fromEntries(['mcp','skill','plugin'].map(kind => [kind, entries.filter(e => e.kind === kind && !e.installed).length])))",
        ),
      ).toEqual({ mcp: 5, skill: 5, plugin: 3 });
      for (const spec of [
        '12px "Commit Mono"',
        '14px "Inter"',
        '600 17px "Barlow Condensed"',
        "500 32px Manrope",
      ]) {
        expect(
          await cdp.evaluate(
            `document.fonts.load(${JSON.stringify(spec)}, "0123").then(fonts => fonts.length)`,
          ),
        ).toBe(1);
      }
      await cdp.evaluate(
        "document.querySelector('[data-action=toggle-team-chat]').click()",
      );
      await waitForCondition(
        cdp,
        "!!document.querySelector('.team-header')",
        "Team Chat to open",
      );
      void cdp.send("Browser.close").catch(() => {});
      expect(
        await Promise.race([exited, Bun.sleep(10_000).then(() => "timeout")]),
      ).toBe(0);
    } finally {
      cdp?.close();
      if (electronProc.exitCode === null) electronProc.kill("SIGTERM");
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!CAN_RUN_ELECTRON_XVFB)(
  "headless Electron under Xvfb enforces security/CSP and completes interactive workbench flows",
  async () => {
    const workDir = await mkdtemp(join(tmpdir(), "mars-shell-xvfb-"));
    const buildDir = join(workDir, "dist");
    const stateDir = join(workDir, "state");
    const connectionPath = join(stateDir, "connection.json");
    let workbench: Awaited<ReturnType<typeof serveWorkbench>> | undefined;
    let cdp: CdpClient | undefined;
    let electronProc: ReturnType<typeof spawn> | undefined;

    try {
      await buildShell(buildDir);
      const fixtureUrl = new URL("../fixtures/workbench.json", import.meta.url);
      const fixture = JSON.parse(
        await readFile(fixtureUrl, "utf8"),
      ) as FixtureData;
      const token = "xvfb-fixture-token-0123456789abcdefghijklmnop";
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      workbench = serveWorkbench({
        api: createFixtureOperations(fixture),
        token,
        port: 0,
      });

      const connection = {
        schema_version: 1,
        url: `http://127.0.0.1:${workbench.port}`,
        token,
        scope: {
          owner_id: fixture.describe.scope.owner_id,
          project_id: fixture.describe.scope.project_id,
        },
      };
      await writeFile(connectionPath, JSON.stringify(connection), {
        mode: 0o600,
      });
      await chmod(connectionPath, 0o600);

      const cdpPort = await freePort();
      electronProc = spawn(
        "xvfb-run",
        [
          "-a",
          ELECTRON_BIN,
          join(buildDir, "main.cjs"),
          `--connection=${connectionPath}`,
          `--remote-debugging-port=${cdpPort}`,
          "--disable-gpu",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: workDir,
          },
        },
      );

      const wsUrl = await waitForPageTarget(cdpPort);
      cdp = await CdpClient.connect(wsUrl);
      await cdp.send("Runtime.enable");

      // Chat starts with conversation history; task sessions belong under Tasks.
      await waitForCondition(
        cdp,
        "Boolean(document.querySelector('[data-page=tasks]'))",
        "Tasks navigation",
      );
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const reachable = (selector: string) =>
        cdp?.evaluate<boolean>(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        button.scrollIntoView({block: "nearest"});
        const r = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));
      })()`);
      expect(await reachable(".new-conversation")).toBe(true);
      await cdp.evaluate("document.querySelector('[data-page=tasks]').click()");
      // Wait for initial task list load
      await waitForCondition(
        cdp,
        "document.querySelectorAll('[data-task-id]').length >= 5",
        "sidebar tasks to render",
      );
      expect(await reachable('[data-task-id="fixture-pending"]')).toBe(true);
      await cdp.send("Emulation.clearDeviceMetricsOverride");

      // 1. Verify runtime Electron security & CSP invariants
      const securityCheck = await cdp.evaluate<{
        origin: string;
        hasRequire: boolean;
        hasProcess: boolean;
        hasIpcRenderer: boolean;
        workbenchFrozen: boolean;
        teamChatFrozen: boolean;
        workbenchKeys: string[];
        teamChatKeys: string[];
        scriptCount: number;
        fetchBlocked: boolean;
      }>(`(async () => {
        let fetchBlocked = false;
        try {
          await fetch("https://example.com/");
        } catch {
          fetchBlocked = true;
        }
        return {
          origin: window.location.origin,
          hasRequire: typeof window.require !== "undefined",
          hasProcess: typeof window.process !== "undefined",
          hasIpcRenderer: typeof window.ipcRenderer !== "undefined",
          workbenchFrozen: Object.isFrozen(window.marsWorkbench),
          teamChatFrozen: Object.isFrozen(window.marsTeamChat),
          workbenchKeys: Object.keys(window.marsWorkbench).sort(),
          teamChatKeys: Object.keys(window.marsTeamChat).sort(),
          scriptCount: document.querySelectorAll("script").length,
          fetchBlocked,
        };
      })()`);

      expect(securityCheck.origin).toBe("mars-shell://app");
      expect(securityCheck.hasRequire).toBe(false);
      expect(securityCheck.hasProcess).toBe(false);
      expect(securityCheck.hasIpcRenderer).toBe(false);
      expect(securityCheck.workbenchFrozen).toBe(true);
      expect(securityCheck.teamChatFrozen).toBe(true);
      expect(securityCheck.workbenchKeys).toEqual([...BRIDGE_METHODS].sort());
      expect(securityCheck.teamChatKeys).toEqual([...TEAM_CHAT_METHODS].sort());
      expect(securityCheck.scriptCount).toBe(1);
      expect(securityCheck.fetchBlocked).toBe(true);

      // 2. Verified task: transcript, diff viewer, host verification badge, verified patch export
      await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-task-id="fixture-completed-verified"]');
        if (!el) throw new Error("missing fixture-completed-verified");
        el.click();
      })()`);
      await waitForCondition(
        cdp,
        "!!document.querySelector('.details-toggle')",
        "task workspace to open",
      );
      await cdp.evaluate("document.querySelector('.details-toggle').click()");
      await waitForCondition(
        cdp,
        "Boolean(document.querySelector('[data-action=\"export-patch\"]')?.getBoundingClientRect().height)",
        "export-patch button on verified task",
      );
      await cdp.evaluate(`(() => {
        document.querySelector('[data-action="export-patch"]').click();
      })()`);
      await waitForCondition(
        cdp,
        "document.body.textContent.includes('Exported ') && document.body.textContent.includes('sha256 verified')",
        "verified patch export confirmation",
      );

      // 3. Unverified task: shows Unverified and does NOT expose export button
      await cdp.evaluate(`(() => {
        document.querySelector('[data-task-id="fixture-completed-unverified"]').click();
      })()`);
      await waitForCondition(
        cdp,
        "document.body.textContent.includes('Unverified') && !document.querySelector('[data-action=\"export-patch\"]')",
        "unverified badge without export button",
      );

      // 4. Pending task: approvals + paid-model consent + start -> steer -> cancel
      await cdp.evaluate(`(() => {
        document.querySelector('[data-task-id="fixture-pending"]').click();
      })()`);
      await waitForCondition(
        cdp,
        "Boolean(document.querySelector('[data-control=\"launch-model\"]'))",
        "launch controls on pending task",
      );
      expect(
        await cdp.evaluate<boolean>(`(() => {
          const bottom = (selector) => document.querySelector(selector).getBoundingClientRect().bottom;
          const transcriptTop = document.querySelector(".transcript").getBoundingClientRect().top;
          const cardBottom = bottom('[data-card="approval-card"]');
          return bottom('[data-action="start-task"]') < cardBottom && cardBottom <= transcriptTop;
        })()`),
      ).toBe(true);

      await cdp.evaluate(`(() => {
        const read = document.querySelector('[data-control="approval-read"]');
        const write = document.querySelector('[data-control="approval-write"]');
        const exec = document.querySelector('[data-control="approval-execute"]');
        for (const box of [read, write, exec]) {
          if (box && !box.checked) {
            box.checked = true;
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        const select = document.querySelector('[data-control="launch-model"]');
        select.value = "paid";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);

      await waitForCondition(
        cdp,
        "Boolean(document.querySelector('[data-control=\"launch-paid-consent\"]'))",
        "paid-model consent checkbox",
      );

      const startDisabledBeforeConsent = await cdp.evaluate<boolean>(
        "Boolean(document.querySelector('[data-action=\"start-task\"]')?.disabled)",
      );
      expect(startDisabledBeforeConsent).toBe(true);

      await cdp.evaluate(`(() => {
        const consent = document.querySelector('[data-control="launch-paid-consent"]');
        consent.checked = true;
        consent.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);

      await waitForCondition(
        cdp,
        "document.querySelector('[data-action=\"start-task\"]')?.disabled === false",
        "start-task enabled after paid consent",
      );

      await cdp.evaluate(`(() => {
        document.querySelector('[data-action="start-task"]').click();
      })()`);

      await waitForCondition(
        cdp,
        "Boolean(document.querySelector('[data-control=\"steer-input\"]'))",
        "running controls after task start",
      );

      await cdp.evaluate(`(() => {
        const input = document.querySelector('[data-control="steer-input"]');
        input.value = "Focus on edge cases";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('[data-action="steer-task"]').click();
      })()`);

      await waitForCondition(
        cdp,
        "document.body.textContent.includes('Steering instruction sent.')",
        "steering confirmation",
      );

      await cdp.evaluate(`(() => {
        document.querySelector('[data-action="cancel-task"]').click();
      })()`);

      await waitForCondition(
        cdp,
        "document.body.textContent.includes('Task cancelled.') && !document.querySelector('[data-control=\"steer-input\"]')",
        "cancelled status after cancel",
      );

      // 5. Prompt composer creates a new task
      await cdp.evaluate(`(() => {
        const prompt = document.querySelector('[data-control="composer-request"]');
        prompt.value = "Audit Xvfb shell build";
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector('[data-action="create-task"]').click();
      })()`);

      await waitForCondition(
        cdp,
        "document.body.textContent.includes('Audit Xvfb shell build')",
        "newly created task in UI",
      );

      // 6. Embedded Team Chat pane: open, send XSS payload, confirm literal text rendering
      await cdp.evaluate(`(() => {
        document.querySelector('[data-action="toggle-team-chat"]').click();
      })()`);

      await waitForCondition(
        cdp,
        "Boolean(document.querySelector('[data-panel=\"team-chat\"] textarea'))",
        "Team Chat composer",
      );

      await cdp.evaluate(`(() => {
        const area = document.querySelector('[data-panel="team-chat"] textarea');
        area.value = "Shipping from Xvfb <script>xss()</script>";
        area.dispatchEvent(new Event("input", { bubbles: true }));
        const send = [...document.querySelectorAll('[data-panel="team-chat"] button')].find(
          (btn) => btn.textContent === "Send message",
        );
        if (!send) throw new Error("Send message button missing");
        send.click();
      })()`);

      await waitForCondition(
        cdp,
        "document.body.textContent.includes('Shipping from Xvfb <script>xss()</script>')",
        "Team Chat message rendered as literal text",
      );

      const finalScriptCount = await cdp.evaluate<number>(
        "document.querySelectorAll('script').length",
      );
      expect(finalScriptCount).toBe(1);
    } finally {
      cdp?.close();
      if (electronProc && !electronProc.killed) {
        electronProc.kill("SIGTERM");
        await Bun.sleep(200);
        if (electronProc.exitCode === null) electronProc.kill("SIGKILL");
      }
      workbench?.stop(true);
      await rm(workDir, { recursive: true, force: true });
    }
  },
  60_000,
);
