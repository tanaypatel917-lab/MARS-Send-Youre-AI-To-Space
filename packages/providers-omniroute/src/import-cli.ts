/**
 * Rebuilds `catalog/free-tier-catalog.json` from a pinned OmniRoute checkout:
 *
 *   bun packages/providers-omniroute/src/import-cli.ts <checkout> [--out <path>]
 *
 * The checkout must be at the revision pinned in `sources/manifest.json`; the
 * revision is read from the checkout with `git rev-parse HEAD` and recorded
 * in the catalog so tests can cross-check the pin.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BUNDLED_CATALOG_PATH } from "./catalog";
import { importFreeTierCatalog, readUpstreamSources } from "./importer";
import { OMNIROUTE_PIN } from "./pin";

async function gitRevision(checkout: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: checkout,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !/^[0-9a-f]{40}$/.test(output))
    throw new Error(`Could not read the git revision of ${checkout}.`);
  return output;
}

async function main(argv: string[]): Promise<void> {
  const checkoutArg = argv[0];
  if (!checkoutArg || checkoutArg.startsWith("--"))
    throw new Error("usage: import-cli.ts <omniroute-checkout> [--out <path>]");
  const checkout = resolve(checkoutArg);
  const outIndex = argv.indexOf("--out");
  const outArg = outIndex === -1 ? undefined : argv[outIndex + 1];
  const out = outArg ? resolve(outArg) : BUNDLED_CATALOG_PATH;
  const revision = await gitRevision(checkout);
  if (revision !== OMNIROUTE_PIN.revision)
    throw new Error(
      `Checkout is at ${revision}; the pinned revision is ${OMNIROUTE_PIN.revision} (${OMNIROUTE_PIN.release}).`,
    );
  const catalog = importFreeTierCatalog(await readUpstreamSources(checkout), {
    repositoryUrl: OMNIROUTE_PIN.repositoryUrl,
    release: OMNIROUTE_PIN.release,
    revision,
  });
  await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(
    JSON.stringify({
      out,
      release: catalog.source.release,
      curated_at: catalog.source.curated_at,
      entries: catalog.entries.length,
    }),
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
