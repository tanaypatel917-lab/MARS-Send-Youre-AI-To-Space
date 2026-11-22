import { createInterface } from "node:readline";

const limit = 32_768;
const displayLimit = 40;
type Fields = Record<string, string>;

// Compare exact JSON decimals, not their rounded IEEE-754 approximations.
function parseDocument(text: string): unknown {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === "string") return `s:${value}`;
      if (typeof value !== "number") return value;
      const parts = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(
        context?.source ?? "",
      );
      if (!parts) throw new Error();
      const fraction = parts[3] ?? "";
      const digits = `${parts[2]}${fraction}`.replace(/^0+/, "");
      if (!digits) return "n:0";
      const coefficient = digits.replace(/0+$/, "");
      const power =
        BigInt(parts[4] ?? 0) +
        BigInt(digits.length - coefficient.length - fraction.length);
      return `n:${parts[1]}${coefficient}e${power}`;
    },
  );
}

function compareJson({ before, after }: Fields) {
  if (before === undefined || after === undefined) throw new Error();
  const paths: { change: string; path: string }[] = [];
  let count = 0;
  const found = (change: string, path: string) => {
    count++;
    if (paths.length < displayLimit) paths.push({ change, path });
  };
  const compare = (a: unknown, b: unknown, path: string, depth: number) => {
    if (depth > 64) throw new Error();
    if (a === b) return;
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)
    ) {
      found("changed", path);
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const pointer = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!Object.hasOwn(a, key)) found("added", pointer);
      else if (!Object.hasOwn(b, key)) found("removed", pointer);
      else
        compare(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          pointer,
          depth + 1,
        );
    }
  };
  compare(parseDocument(before), parseDocument(after), "", 0);
  return { count, paths, omitted: count - paths.length };
}

function summarizeDiff({ diff }: Fields) {
  if (!diff) throw new Error();
  const files: {
    path: string;
    added: number;
    removed: number;
    hunks: number;
  }[] = [];
  let oldPath = "";
  let current: (typeof files)[number] | undefined;
  let oldLines = 0,
    newLines = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (oldLines || newLines) {
      if (!current) throw new Error();
      switch (line[0]) {
        case " ":
          oldLines--;
          newLines--;
          break;
        case "+":
          newLines--;
          current.added++;
          break;
        case "-":
          oldLines--;
          current.removed++;
          break;
        default:
          throw new Error();
      }
      if (oldLines < 0 || newLines < 0) throw new Error();
    } else if (line.startsWith("--- ")) {
      oldPath = line.slice(4).split("\t")[0] ?? "";
      current = undefined;
    } else if (line.startsWith("+++ ") && oldPath) {
      const path = line.slice(4).split("\t")[0];
      if (!path) throw new Error();
      current = {
        path: path === "/dev/null" ? oldPath : path,
        added: 0,
        removed: 0,
        hunks: 0,
      };
      files.push(current);
      oldPath = "";
    } else if (line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!match || !current) throw new Error();
      oldLines = Number(match[1] ?? 1);
      newLines = Number(match[2] ?? 1);
      current.hunks++;
    }
  }
  if (!files.some((file) => file.hunks) || oldLines || newLines)
    throw new Error();
  return {
    textFiles: files.length,
    added: files.reduce((n, file) => n + file.added, 0),
    removed: files.reduce((n, file) => n + file.removed, 0),
    files: files.slice(0, displayLimit),
    omitted: Math.max(0, files.length - displayLimit),
  };
}

const tools = {
  compare_json: {
    description:
      "Compare two JSON strings and return changed JSON Pointer paths, not values. Array positions are compared by index.",
    fields: ["before", "after"],
    run: compareJson,
  },
  summarize_diff: {
    description:
      "Count added and removed lines per file in a supplied unified text diff. Binary files and renames without text changes are not counted.",
    fields: ["diff"],
    run: summarizeDiff,
  },
} as const;
const name = process.argv[2];
if (name !== "compare_json" && name !== "summarize_diff")
  throw new Error("Missing bundled tool.");
const tool = tools[name];
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: tool.fields,
  properties: Object.fromEntries(
    tool.fields.map((k) => [k, { type: "string", maxLength: limit }]),
  ),
};
const send = (id: unknown, response: object) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", id, ...response }));
for await (const line of createInterface({ input: process.stdin })) {
  let request: {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Fields };
  };
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (!request || request.id === undefined) continue;
  const { id, method, params } = request;
  if (method === "initialize")
    send(id, {
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name, version: "1.0.0" },
      },
    });
  else if (method === "tools/list")
    send(id, {
      result: { tools: [{ name, description: tool.description, inputSchema }] },
    });
  else if (method === "ping") send(id, { result: {} });
  else if (method === "tools/call" && params?.name === name) {
    try {
      const args = params.arguments;
      if (
        !args ||
        typeof args !== "object" ||
        Object.keys(args).length !== tool.fields.length ||
        !tool.fields.every(
          (k) => typeof args[k] === "string" && args[k].length <= limit,
        )
      )
        throw new Error();
      send(id, {
        result: {
          content: [{ type: "text", text: JSON.stringify(tool.run(args)) }],
        },
      });
    } catch {
      send(id, {
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "Invalid or unsupported input; supply complete text within the tool limits.",
            },
          ],
        },
      });
    }
  } else
    send(id, { error: { code: -32601, message: "Unknown method or tool" } });
}
