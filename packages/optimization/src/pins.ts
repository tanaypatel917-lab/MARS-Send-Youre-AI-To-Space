import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Runtime pins for the isolated GEPA worker. `gepa_source_revision` is the
 * gepa v0.1.4 tag commit; the audited HEAD in sources/manifest.json differs,
 * which is why GEPA runs in its own venv rather than next to DSPy.
 */
export const OPTIMIZATION_PINS = {
  gepa_version: "0.1.4",
  gepa_source_revision: "8b0ce6cd99a234f6b74daf37558a2ac0ce18f975",
  python_version_prefix: "3.12",
} as const;

export const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
export const PYTHON_DIR = path.join(PACKAGE_DIR, "python");
export const WORKER_MODULE = "mars_gepa_worker";

export function defaultWorkerPython(): string {
  return path.join(PYTHON_DIR, ".venv", "bin", "python");
}

export function workerAvailable(pythonPath = defaultWorkerPython()): boolean {
  return existsSync(pythonPath);
}

export const WORKER_SETUP_HINT =
  "GEPA worker venv missing. Run: cd packages/optimization/python && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.lock";
