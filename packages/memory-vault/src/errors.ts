export type VaultErrorCode =
  | "no_manifest"
  | "corrupt_manifest"
  | "scope_mismatch"
  | "invalid_graph"
  | "invalid_context";

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    detail?: string,
  ) {
    super(
      detail ? `memory-vault: ${code}: ${detail}` : `memory-vault: ${code}`,
    );
    this.name = "VaultError";
  }
}
