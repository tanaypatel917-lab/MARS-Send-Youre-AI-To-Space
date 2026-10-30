import { probeExecution } from "@mars/execution";

const command = process.argv[2];
try {
  if (command === "doctor") {
    const report = {
      product: "MARS - Send You're AI To Space",
      milestone: "0: source and integration baseline",
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      execution: await probeExecution(),
      limitations: [
        "Initialization probe only; no agent task or model request was run.",
        "IDE, durable task API, checkpoints, memory, learning, and training are not implemented.",
        "Python services must use separate versioned environments.",
      ],
    };
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "smoke") {
    console.log(JSON.stringify(await probeExecution(), null, 2));
  } else {
    console.error("Usage: bun apps/cli/src/main.ts <doctor|smoke>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "MARS command failed");
  process.exitCode = 1;
}
