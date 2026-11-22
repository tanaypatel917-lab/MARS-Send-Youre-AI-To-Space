import { z } from "zod";
import { CATALOG, findExtension } from "./extension-catalog";

const id = z.string().refine((id) => Boolean(findExtension(id)));
const list = z.object({ action: z.literal("list") }).strict();
const install = z.object({ action: z.literal("install"), id }).strict();
export const ExtensionAction = z.discriminatedUnion("action", [
  list,
  install,
  z.object({ action: z.literal("remove"), id }).strict(),
]);
export type ExtensionAction = z.infer<typeof ExtensionAction>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const OperatorAction = z.union([
  list,
  install,
  z.object({ action: z.literal("restore"), id, revision }).strict(),
  z.object({ action: z.literal("preview-remove"), id }).strict(),
  z.object({ action: z.literal("remove"), id, revision }).strict(),
]);
export type OperatorAction = z.infer<typeof OperatorAction>;
export const EXPIRED_PREFIX = "MARS_EXTENSION_EXPIRED ";
export const ExtensionRequest = z
  .object({
    token: z.string().uuid(),
    request: OperatorAction,
  })
  .strict();
export const REPLY_PREFIX = "MARS_EXTENSIONS ";
const ids = z.array(id).max(CATALOG.length);
const Removal = z
  .object({
    id,
    revision,
    archive: ids,
    keep: z
      .array(
        z
          .object({
            name: id,
            reason: z.enum(["shared", "customized", "pinned", "pre-existing"]),
          })
          .strict(),
      )
      .max(CATALOG.length),
  })
  .strict();
export type Removal = z.infer<typeof Removal>;
export const CatalogStatus = z
  .object({
    installed: ids,
    expired: ids,
    conflicts: ids,
    revision: revision.optional(),
    removable: ids.optional(),
    removal: Removal.optional(),
  })
  .strict();
export type CatalogStatus = z.infer<typeof CatalogStatus>;
export const ExtensionReply = z
  .object({
    token: z.string().uuid(),
    status: CatalogStatus.nullable(),
  })
  .strict();
