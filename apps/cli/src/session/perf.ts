import { SessionClient } from "./client";
import { SessionController } from "./controller";
import { fixtureWorkbench } from "./fixture";
import { initialState, renderScreen } from "./screen";

/** Fixture-only budget probe for §8.1: prints JSON, never touches a workbench or model. */
export async function measure(width = 120, height = 40) {
  const before = process.memoryUsage().rss;
  const workbench = fixtureWorkbench({ large: true });
  const state = initialState({ depth: "truecolor" });
  const controller = new SessionController(
    new SessionClient(workbench.transport),
    state,
    () => {},
  );
  await controller.connect();
  let start = performance.now();
  renderScreen(state, width, height);
  const first = performance.now() - start;
  const frames: number[] = [];
  for (let index = 0; index < 60; index++) {
    state.spinnerFrame++;
    if (index % 10 === 0)
      state.expanded.add(state.projection?.entries.at(-1 - index)?.id ?? "");
    start = performance.now();
    renderScreen(state, width, height);
    frames.push(performance.now() - start);
  }
  frames.sort((a, b) => a - b);
  Bun.gc(true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cpuStart = process.cpuUsage();
  const wall = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const cpu = process.cpuUsage(cpuStart);
  const idleCpu = (cpu.user + cpu.system) / 1_000 / (performance.now() - wall);
  return {
    events: workbench.events.length,
    entries: state.projection?.entries.length ?? 0,
    first_frame_ms: first,
    frame_p50_ms: frames[Math.floor(frames.length / 2)] ?? 0,
    frame_max_ms: frames.at(-1) ?? 0,
    idle_cpu_ratio: idleCpu,
    heap_mb: process.memoryUsage().heapUsed / 1_048_576,
    rss_mb: process.memoryUsage().rss / 1_048_576,
    rss_delta_mb: (process.memoryUsage().rss - before) / 1_048_576,
    model_requests: 0,
  };
}

if (import.meta.main) console.log(JSON.stringify(await measure(), null, 2));
