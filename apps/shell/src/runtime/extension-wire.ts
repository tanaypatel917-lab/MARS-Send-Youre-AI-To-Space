import { z } from "zod";
import { CATALOG, findExtension } from "./extension-catalog";

const id = z.string().refine((id) => Boolean(findExtension(id)));
export const ExtensionAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("install"), id }).strict(),
]);
export type ExtensionAction = z.infer<typeof ExtensionAction>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const OperatorAction = z.union([
  ExtensionAction,
  z.object({ action: z.literal("restore"), id, revision }).strict(),
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
export const CatalogStatus = z
  .object({
    installed: ids,
    expired: ids,
    conflicts: ids,
    revision: revision.optional(),
  })
  .strict();
export type CatalogStatus = z.infer<typeof CatalogStatus>;
export const ExtensionReply = z
  .object({
    token: z.string().uuid(),
    status: CatalogStatus.nullable(),
  })
  .strict();
