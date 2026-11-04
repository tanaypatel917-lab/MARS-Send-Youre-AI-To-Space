import { describe, expect, test } from "bun:test";
import { checkSources, ROOT, validateManifest } from "./check-sources";

const raw: unknown = await Bun.file(`${ROOT}/sources/manifest.json`).json();
const manifest = validateManifest(raw);

describe("source manifest validation", () => {
  test("validates the complete manifest and installed artifact/lock pins", async () => {
    expect((await checkSources()).components).toHaveLength(30);
  });
  test("accepts the host-bound-tools status and rejects unknown statuses", () => {
    const watch = manifest.components.find((c) => c.id === "watch-skill");
    expect(watch?.integration_status).toBe("host-bound-tools");
    expect(watch?.group).toBe("perception-verification");
    const changed = structuredClone(manifest);
    const target = changed.components.find((c) => c.id === "watch-skill");
    if (!target) throw new Error("Fixture missing");
    (target as { integration_status: string }).integration_status = "wrapped";
    expect(() => validateManifest(changed)).toThrow();
  });
  test("rejects floating revisions and mutable source references", () => {
    const changed = structuredClone(manifest);
    const first = changed.components[0];
    if (!first) throw new Error("Fixture missing");
    first.revision = "main";
    expect(() => validateManifest(changed)).toThrow();
    first.revision = manifest.components[0]?.revision ?? "";
    first.license.url = `${first.repository_url}/blob/main/LICENSE`;
    expect(() => validateManifest(changed)).toThrow("Unpinned source URL");
  });
  test("rejects duplicate IDs, missing components, and conflicting repository pins", () => {
    const changed = structuredClone(manifest);
    const first = changed.components[0];
    if (!first) throw new Error("Fixture missing");
    changed.components.push(first);
    expect(() => validateManifest(changed)).toThrow("Duplicate component");
    changed.components.pop();
    changed.components.shift();
    expect(() => validateManifest(changed)).toThrow(
      "Missing required component",
    );
    changed.components.unshift(first);
    first.revision = "a".repeat(40);
    first.license.url = `${first.repository_url}/blob/${first.revision}/${first.license.path}`;
    for (const source of first.sources) {
      source.url = `${first.repository_url}/blob/${first.revision}/${source.path}`;
    }
    expect(() => validateManifest(changed)).toThrow(
      "Conflicting repository pins",
    );
  });
  test("does not accept missing license or acceptance evidence fields", () => {
    const changed = structuredClone(manifest);
    const first = changed.components[0];
    if (!first) throw new Error("Fixture missing");
    first.license.spdx = "";
    expect(() => validateManifest(changed)).toThrow();
    first.license.spdx = "MIT";
    first.acceptance_plan = {};
    expect(() => validateManifest(changed)).toThrow();
  });
});
