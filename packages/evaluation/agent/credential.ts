/**
 * Removes a credential from a process environment and returns its value.
 *
 * Task commands spawned by the agent can read this process's environment
 * through `/proc/<pid>/environ`, so the model credential must not stay in
 * `process.env` once the runtime has been given its own copy.
 */
export function claimCredential(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  delete env[name];
  return value;
}
