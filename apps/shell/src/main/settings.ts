import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const WindowLayoutSchema = z
  .object({
    schema_version: z.literal(1),
    window: z
      .object({
        width: z.number().int().min(60).max(8192),
        height: z.number().int().min(60).max(8192),
      })
      .strict(),
  })
  .strict();

export type WindowLayout = { width: number; height: number };

export const DEFAULT_WINDOW_LAYOUT: WindowLayout = {
  width: 1280,
  height: 800,
};

export function layoutPath(homeDir: string): string {
  return join(homeDir, ".mars", "shell", "layout.json");
}

export async function loadWindowLayout(
  filePath: string,
): Promise<WindowLayout> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = WindowLayoutSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.window : { ...DEFAULT_WINDOW_LAYOUT };
  } catch {
    return { ...DEFAULT_WINDOW_LAYOUT };
  }
}

export async function saveWindowLayout(
  filePath: string,
  layout: WindowLayout,
): Promise<void> {
  const value = WindowLayoutSchema.parse({
    schema_version: 1,
    window: layout,
  });
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `layout.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
