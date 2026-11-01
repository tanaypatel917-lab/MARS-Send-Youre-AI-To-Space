import { describe, expect, test } from "bun:test";
import { isGitignored, parseGitignore } from "../src/gitignore";
import { context, providerFor, putFile, tempRoot, workspace } from "./helpers";

describe(".gitignore matching", () => {
  test("supports anchored patterns, negation, directory rules, globstars, and classes", () => {
    const rules = parseGitignore(
      "/root-only.ts\n*.tmp\n!important.tmp\nlogs/\n**/cache/**/[ab].js\n",
    );
    const rootRules = [{ prefix: "", rules }];
    expect(isGitignored("root-only.ts", false, rootRules)).toBe(true);
    expect(isGitignored("nested/root-only.ts", false, rootRules)).toBe(false);
    expect(isGitignored("hidden.tmp", false, rootRules)).toBe(true);
    expect(isGitignored("important.tmp", false, rootRules)).toBe(false);
    expect(isGitignored("logs", true, rootRules)).toBe(true);
    expect(isGitignored("logs", false, rootRules)).toBe(false);
    expect(isGitignored("logs/app.ts", false, rootRules)).toBe(true);
    expect(isGitignored("src/cache/generated/a.js", false, rootRules)).toBe(
      true,
    );
    expect(isGitignored("src/cache/generated/c.js", false, rootRules)).toBe(
      false,
    );
  });

  test("applies nested overrides from parent to child", () => {
    const rules = [
      { prefix: "", rules: parseGitignore("src/*.ts") },
      { prefix: "src", rules: parseGitignore("!visible.ts") },
    ];
    expect(isGitignored("src/hidden.ts", false, rules)).toBe(true);
    expect(isGitignored("src/visible.ts", false, rules)).toBe(false);
  });

  test("preserves an escaped trailing pattern space", () => {
    const rules = [{ prefix: "", rules: parseGitignore("space\\ \n") }];
    expect(isGitignored("space ", false, rules)).toBe(true);
    expect(isGitignored("space", false, rules)).toBe(false);
  });

  test("uses root and nested ignore files while walking", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      ".gitignore",
      "ignored.ts\n*.tmp.ts\n!important.tmp.ts\nskip-dir/\n",
    );
    await putFile(root, "ignored.ts", "export const ignoredSentinel = 1;\n");
    await putFile(
      root,
      "hidden.tmp.ts",
      "export const hiddenTmpSentinel = 1;\n",
    );
    await putFile(
      root,
      "important.tmp.ts",
      "export const importantSentinel = 1;\n",
    );
    await putFile(
      root,
      "skip-dir/child.ts",
      "export const skippedChildSentinel = 1;\n",
    );
    await putFile(root, "kept.ts", "export const keptSentinel = 1;\n");
    await putFile(root, "src/.gitignore", "hidden.ts\n");
    await putFile(root, "src/hidden.ts", "export const hiddenSentinel = 1;\n");
    await putFile(
      root,
      "src/visible.ts",
      "export const visibleSentinel = 1;\n",
    );
    const provider = providerFor(root);
    const result = await provider.map(context, {
      workspace,
      max_output_tokens: 1000,
    });
    expect(result.text).toContain("kept.ts");
    expect(result.text).toContain("visible.ts");
    expect(result.text).toContain("important.tmp.ts");
    expect(result.text).not.toContain("ignored.ts");
    expect(result.text).not.toContain("hidden.tmp.ts");
    expect(result.text).not.toContain("skip-dir/child.ts");
    expect(result.text).not.toContain("hidden.ts");
    expect(result.stats.skipped.gitignored).toBe(4);
  });
});
