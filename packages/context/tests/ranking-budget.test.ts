import { describe, expect, test } from "bun:test";
import { conservativeTokenCounter, utf8ByteTokenCounter } from "../src";
import { extractPython } from "../src/extract-python";
import { context, providerFor, putFile, tempRoot, workspace } from "./helpers";

describe("extractors and ranking", () => {
  test("ranks a mentioned TypeScript symbol above unrelated modules", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      "src/auth/session.ts",
      "export function validateSessionToken(token: string) { return Boolean(token); }\n",
    );
    for (let index = 0; index < 3; index += 1) {
      await putFile(
        root,
        `src/callers/caller-${index}.ts`,
        `import { validateSessionToken } from '../auth/session';\nexport const result${index} = validateSessionToken('x');\n`,
      );
    }
    for (let index = 0; index < 10; index += 1) {
      await putFile(
        root,
        `src/distractors/module-${index}.ts`,
        `export function helper${index}() { return item${index} + value${index}; }\nexport const value${index} = ${index};\n`,
      );
    }
    const provider = providerFor(root);
    const result = await provider.map(context, {
      workspace,
      query: "validateSessionToken session validation",
      mentioned_symbols: ["validateSessionToken"],
      max_output_tokens: 1000,
    });
    expect(result.files[0]?.path).toBe("src/auth/session.ts");
    expect(result.files[0]?.symbols[0]?.name).toBe("validateSessionToken");
    expect(
      result.files.findIndex((file) =>
        file.path.startsWith("src/distractors/"),
      ),
    ).toBeGreaterThan(0);
  });

  test("mentioned files receive personalization and Python definitions are ranked", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      "src/auth/session.py",
      "def validate_session(token):\n    return token is not None\n",
    );
    await putFile(
      root,
      "src/caller.py",
      "from auth.session import validate_session\nvalidate_session('x')\n",
    );
    await putFile(root, "src/other.py", "def unrelated():\n    return 1\n");
    const provider = providerFor(root);
    const mentioned = await provider.map(context, {
      workspace,
      mentioned_files: ["src/other.py"],
      max_output_tokens: 200,
    });
    expect(mentioned.files[0]?.path).toBe("src/other.py");
    const smoke = await provider.map(context, {
      workspace,
      query: "validate session token",
      mentioned_symbols: ["validate_session"],
      max_output_tokens: 300,
    });
    expect(
      smoke.files.some((file) =>
        file.symbols.some((symbol) => symbol.name === "validate_session"),
      ),
    ).toBe(true);
  });

  test("counts Python definitions while ignoring simple string and comment contents", () => {
    const result = extractPython(
      '"""ignored fakeName"""\n# def hidden():\ndef visible(value):\n    text = "fakeReference"\n    return value\n',
      100,
    );
    expect(result.defs.map((definition) => definition.name)).toEqual([
      "visible",
    ]);
    expect(result.refs.has("fakeName")).toBe(false);
    expect(result.refs.has("hidden")).toBe(false);
    expect(result.refs.has("fakeReference")).toBe(false);
  });
});

describe("budget packing", () => {
  test("fits every requested budget and emits only complete symbol lines", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      "src/a.ts",
      "export function firstFunction(input: string) { return input; }\n",
    );
    await putFile(
      root,
      "src/b.ts",
      "export class SecondClass { method(value: number) { return value; } }\n",
    );
    await putFile(
      root,
      "src/README-less.ts",
      "export const simpleValue = 3;\n",
    );
    const provider = providerFor(root);
    let priorSymbols = 0;
    for (const budget of [1, 20, 50, 100, 300, 1000]) {
      const result = await provider.map(context, {
        workspace,
        max_output_tokens: budget,
      });
      expect(result.token_count).toBeLessThanOrEqual(budget);
      expect(result.token_count).toBe(
        conservativeTokenCounter.count(result.text),
      );
      let currentPath: string | undefined;
      for (const line of result.text.split("\n")) {
        if (!line) continue;
        if (!line.startsWith(" ")) {
          currentPath = line.endsWith(":") ? line.slice(0, -1) : line;
          continue;
        }
        const match = /^\s+(\d+)│ (.*)$/.exec(line);
        expect(match).not.toBeNull();
        const file = result.files.find((entry) => entry.path === currentPath);
        expect(
          file?.symbols.some(
            (symbol) =>
              symbol.line === Number(match?.[1]) &&
              symbol.signature === match?.[2]?.trimStart(),
          ),
        ).toBe(true);
      }
      expect(result.stats.selected_symbols).toBeGreaterThanOrEqual(
        priorSymbols,
      );
      priorSymbols = result.stats.selected_symbols;
    }
    const tiny = await provider.map(context, {
      workspace,
      max_output_tokens: 1,
    });
    expect(tiny.text).toBe("");
    expect(tiny.truncated).toBe(true);
  });

  test("uses the supplied token counter and retains a full name in truncated signatures", async () => {
    const root = await tempRoot();
    const longName = `extraordinarilyLongIdentifier${"x".repeat(65)}`;
    await putFile(
      root,
      "long.ts",
      `export function ${longName}(input: ${"VeryLongType".repeat(12)}) { return input; }\n`,
    );
    const counter = {
      id: "unit-test-counter",
      count: (text: string) => utf8ByteTokenCounter.count(text) * 2,
    };
    const provider = providerFor(root, { tokenCounter: counter });
    const result = await provider.map(context, {
      workspace,
      max_output_tokens: 4096,
    });
    expect(result.token_policy).toBe(counter.id);
    expect(result.token_count).toBe(counter.count(result.text));
    expect(result.text).toContain(longName);
    expect(result.text).toContain("…");
  });

  test("counts definitions removed by the per-file symbol limit", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      "many.ts",
      "export const alpha = 1;\nexport const bravo = 2;\n",
    );
    const provider = providerFor(root, {
      limits: { maxSymbolsPerFile: 1 },
    });
    const result = await provider.map(context, {
      workspace,
      max_output_tokens: 200,
    });
    expect(result.complete).toBe(true);
    expect(result.stats.skipped.limit).toBe(1);
    const reused = await provider.map(context, {
      workspace,
      query: "different",
      max_output_tokens: 200,
    });
    expect(reused.stats.files_parsed).toBe(0);
    expect(reused.stats.skipped.limit).toBe(1);
  });

  test("marks results truncated when the ranking candidate limit is reached", async () => {
    const root = await tempRoot();
    await putFile(
      root,
      "many.ts",
      "export const alpha = 1;\nexport const bravo = 2;\n",
    );
    const result = await providerFor(root, {
      limits: { maxCandidates: 1 },
    }).map(context, { workspace, max_output_tokens: 200 });
    expect(result.stats.candidates).toBe(1);
    expect(result.truncated).toBe(true);
  });

  test("keeps multiline Python signatures without adding function bodies", () => {
    const result = extractPython(
      "def make_item(\n    key: str,\n) -> dict[str, str]:\n    return {key: key}\n",
      100,
    );
    expect(result.defs[0]?.signature).toBe(
      "def make_item( key: str, ) -> dict[str, str]",
    );
    expect(result.defs[0]?.signature).not.toContain("return");

    const quotedComment = extractPython(
      'def parse_value(value="# literal"):\n    return value\n',
      100,
    );
    expect(quotedComment.defs[0]?.signature).toBe(
      'def parse_value(value="# literal")',
    );
    expect(
      extractPython("def one_line(value): return value\n", 100).defs[0]
        ?.signature,
    ).toBe("def one_line(value)");
    expect(extractPython("class OneLine: pass\n", 100).defs[0]?.signature).toBe(
      "class OneLine",
    );
    expect(
      extractPython('# """\ndef visible_after_comment():\n    return 1\n', 100)
        .defs[0]?.name,
    ).toBe("visible_after_comment");
  });

  test("is deterministic across fresh providers and file creation order", async () => {
    const firstRoot = await tempRoot();
    const secondRoot = await tempRoot();
    const entries = [
      ["src/zeta.ts", "export const zeta = 1;\n"],
      ["src/alpha.ts", "export function alpha() { return zeta; }\n"],
      ["src/beta.ts", "export function beta() { return alpha; }\n"],
    ] as const;
    for (const [path, source] of entries)
      await putFile(firstRoot, path, source);
    for (const [path, source] of [...entries].reverse())
      await putFile(secondRoot, path, source);
    const request = { workspace, query: "alpha", max_output_tokens: 500 };
    const first = await providerFor(firstRoot).map(context, request);
    const second = await providerFor(firstRoot).map(context, request);
    const shuffled = await providerFor(secondRoot).map(context, request);
    expect(second.text).toBe(first.text);
    expect(second.files).toEqual(first.files);
    expect(shuffled.text).toBe(first.text);
    expect(shuffled.files).toEqual(first.files);
  });
});
