import { createHash } from "node:crypto";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { IntegrityError, WorkspaceNotFoundError } from "./errors";
import type { ArtifactStore } from "./types";

export function createInMemoryArtifactStore(): ArtifactStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(
      _context: RequestContext,
      input: Uint8Array,
      mediaType: string,
    ): Promise<ArtifactRef> {
      const data = new Uint8Array(input);
      const hash = createHash("sha256").update(data).digest("hex");
      const artifact: ArtifactRef = {
        artifact_id: `art_${hash}`,
        sha256: hash,
        media_type: mediaType,
        byte_length: data.byteLength,
      };
      blobs.set(artifact.artifact_id, data);
      return artifact;
    },
    async get(_context: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
      const data = blobs.get(ref.artifact_id);
      if (!data) throw new WorkspaceNotFoundError();
      const hash = createHash("sha256").update(data).digest("hex");
      if (hash !== ref.sha256 || data.byteLength !== ref.byte_length) {
        throw new IntegrityError("In-memory artifact reference mismatch");
      }
      return new Uint8Array(data);
    },
  };
}
