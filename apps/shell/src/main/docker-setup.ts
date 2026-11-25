export async function ensureDockerImage(
  image: string,
  run: (args: string[]) => Promise<boolean>,
  confirmPull: () => Promise<boolean>,
) {
  if (await run(["image", "inspect", image])) return "present";
  if (!(await confirmPull())) return "cancelled";
  return (await run(["pull", image])) ? "downloaded" : "failed";
}
