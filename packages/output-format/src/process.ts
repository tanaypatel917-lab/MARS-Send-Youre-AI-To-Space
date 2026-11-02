import type {
  FollowUp,
  OutputDocument,
  OutputError,
  OutputValidationContext,
} from "@mars/contracts";
import { parseOutput } from "./parse";
import { validateOutput } from "./validate";

export interface ProcessedOutput {
  document: OutputDocument;
  errors: OutputError[];
  ok: boolean;
}

/** Parse then validate in one call; the usual entry point for hosts and renderers. */
export function processOutput(
  text: string,
  context: OutputValidationContext,
): ProcessedOutput {
  const document = parseOutput(text);
  const { ok, errors } = validateOutput(document, context);
  return { document, errors, ok };
}

export function followUps(document: OutputDocument): FollowUp[] {
  return document.segments.filter(
    (segment): segment is FollowUp => segment.kind === "follow_up",
  );
}
