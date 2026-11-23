import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const VERIFICATION_IMAGE =
  "mirror.gcr.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";

export const EXAMPLE_BUG = `#!/bin/sh
total=0
while IFS= read -r amount; do
  total=$((total + amount))
done < "$1"
printf '%s\\n' "$total"
`;

export async function seedVerificationExample(root: string) {
  const source = join(root, "verification-example");
  const host = join(root, "verification-host");
  for (const path of [source, host]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const files = {
    "total.sh": EXAMPLE_BUG,
    "amounts.txt": "12\n7\n5",
    "README.md": `# Verification example

Fix total.sh: it drops the last amount when the input has no trailing newline.
The correct total of amounts.txt is 24. Keep support for empty files and files
with a trailing newline. Use POSIX sh (the sandbox has BusyBox).

Choose Project → Set Up Verification Sandbox… if verification is unavailable.
Start a task with Read + Write + Execute and the Amount totals check selected.
Fix the bug so the protected check passes. Inspect the diff and verdict, then
export the verified patch. The check is host-owned outside this project;
editing a candidate test cannot bypass it. Export does not change this project.
`,
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(source, name), contents, {
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const test = join(host, "check.sh");
  await writeFile(
    test,
    `#!/bin/sh
set -eu
printf '12\\n7\\n5' > /tmp/amounts
[ "$(sh total.sh /tmp/amounts)" = 24 ]
printf '12\\n7\\n5\\n' > /tmp/amounts
[ "$(sh total.sh /tmp/amounts)" = 24 ]
: > /tmp/amounts
[ "$(sh total.sh /tmp/amounts)" = 0 ]
printf 'amount totals passed\\n'
`,
    { mode: 0o600 },
  );
  const checksFile = join(host, "checks.json");
  await writeFile(
    checksFile,
    JSON.stringify({
      schema_version: 1,
      checks: [
        {
          id: "amount-totals",
          label: "Amount totals",
          description:
            "Totals include the last row, with or without a trailing newline; empty input is zero.",
          argv: ["sh", ".mars-check.sh"],
          protected_files: [{ path: ".mars-check.sh", source: "check.sh" }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  await chmod(test, 0o600);
  await chmod(checksFile, 0o600);
  return { source, checksFile };
}
