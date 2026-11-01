import type { TokenCounter } from "./types";

export const conservativeTokenCounter: TokenCounter = Object.freeze({
  id: "mars-conservative-v1",
  count: (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3),
});

export const utf8ByteTokenCounter: TokenCounter = Object.freeze({
  id: "utf8-bytes",
  count: (text: string) => Buffer.byteLength(text, "utf8"),
});
