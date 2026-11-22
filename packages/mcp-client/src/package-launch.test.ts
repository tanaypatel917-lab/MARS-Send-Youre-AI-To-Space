import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { preparePackageLaunch } from "./package-launch";
import { McpPackageStore } from "./package-store";

test("a single-file executable retains its invocation name after publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mars-command-alias-"));
  try {
    const src = join(dir, "src");
    await mkdir(src);
    const binary = join(src, "multicall");
    const alias = join(src, "applet");
    await writeFile(binary, '#!/bin/sh\nprintf "%s" "${0##*/}"\n', {
      mode: 0o700,
    });
    await symlink(binary, alias);
    const launch = await preparePackageLaunch(
      "alias",
      {
        type: "stdio",
        command: alias,
        args: [],
        env_allowlist: [],
        launch: { version: 1, arguments: [] },
      },
      new McpPackageStore({
        directory: join(dir, "store"),
        workspaceRoots: [src],
      }),
    );
    await launch.install();
    expect(launch.config.command).not.toBe(alias);
    expect(basename(launch.config.command)).toBe("applet");
    expect(Bun.spawnSync([launch.config.command]).stdout.toString()).toBe(
      "applet",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
