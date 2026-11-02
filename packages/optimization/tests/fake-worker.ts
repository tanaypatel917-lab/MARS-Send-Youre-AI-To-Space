/**
 * Misbehaving stand-ins for the Python worker, used by the TypeScript tests
 * to prove the host enforces its bounds against an untrusted process.
 */
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "stall";
const out = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const input = createInterface({ input: process.stdin });
const lines: string[] = [];
const waiters: ((line: string) => void)[] = [];
input.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else lines.push(line);
});
const next = () =>
  new Promise<string>((resolve) => {
    const line = lines.shift();
    if (line !== undefined) resolve(line);
    else waiters.push(resolve);
  });
const forever = () => new Promise<never>(() => undefined);

const start = JSON.parse(await next()) as {
  expected: { gepa_version: string };
  seed_candidate: Record<string, string>;
  validation: { instance_id: string }[];
  budget: unknown;
};
if (mode === "stall") await forever();
if (mode === "garbage") {
  process.stdout.write("this is not json\n");
  await forever();
}
if (mode === "bad-pin") {
  out({ type: "ready", gepa_version: "9.9.9", python_version: "3.12.0" });
  await forever();
}
out({
  type: "ready",
  gepa_version: start.expected.gepa_version,
  python_version: "3.12.0",
});
const request = (
  id: number,
  components: Record<string, string>,
  ids: string[],
) => ({
  type: "score",
  id,
  request: {
    candidate: {
      candidate_id: `cand-${id}`,
      components,
      parent_candidate_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    split: "validation",
    instance_ids: ids,
    repeats: 1,
    budget: start.budget,
  },
});
if (mode === "foreign") {
  out(request(0, start.seed_candidate, ["not-in-any-split"]));
  await forever();
}
if (mode === "loop") {
  const ids = start.validation.map((item) => item.instance_id);
  for (let i = 0; i < 1000; i += 1) {
    const components =
      i === 0
        ? start.seed_candidate
        : Object.fromEntries(
            Object.entries(start.seed_candidate).map(([key, value]) => [
              key,
              `${value} v${i}`,
            ]),
          );
    out(request(i, components, ids));
    const reply = JSON.parse(await next()) as { type: string };
    if (reply.type !== "score_result") break;
  }
  await forever();
}
await forever();
