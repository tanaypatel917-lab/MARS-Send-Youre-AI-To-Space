import type { ArtifactRef } from "@mars/contracts";
import type { ArtifactData } from "../shared/methods";

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto,
): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function verifyArtifact(
  ref: ArtifactRef,
  data: ArtifactData,
  subtle: SubtleCrypto,
): Promise<boolean> {
  if (
    data.media_type !== ref.media_type ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data.data_base64,
    )
  )
    return false;
  let bytes: Uint8Array;
  try {
    const binary = atob(data.data_base64);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  if (bytes.byteLength !== ref.byte_length) return false;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  return (await sha256Hex(digestInput, subtle)) === ref.sha256;
}
