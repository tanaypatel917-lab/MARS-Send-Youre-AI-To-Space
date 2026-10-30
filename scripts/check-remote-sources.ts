import { checkSources } from "./check-sources";

const manifest = await checkSources();
const urls = [
  ...new Set(
    manifest.components.flatMap((component) =>
      [...component.sources, component.license].map((source) =>
        source.url
          .replace("https://github.com/", "https://raw.githubusercontent.com/")
          .replace("/blob/", "/"),
      ),
    ),
  ),
];
const failures: string[] = [];
const verified: { url: string; sha256: string }[] = [];
let index = 0;
async function worker(): Promise<void> {
  while (index < urls.length) {
    const url = urls[index++];
    if (!url) break;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      verified.push({
        url,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      failures.push(
        `${url}: ${error instanceof Error ? error.message : "Fetch failed"}`,
      );
    }
  }
}
await Promise.all(Array.from({ length: 5 }, () => worker()));
console.log(
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      verified: verified.sort((a, b) => a.url.localeCompare(b.url)),
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
