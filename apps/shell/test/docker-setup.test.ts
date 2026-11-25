import { expect, test } from "bun:test";
import { ensureDockerImage } from "../src/main/docker-setup";

test("an already downloaded sandbox does not prompt or download again", async () => {
  const calls: string[][] = [];
  const status = await ensureDockerImage(
    "example@sha256:digest",
    async (args) => {
      calls.push(args);
      return true;
    },
    async () => {
      throw new Error("An installed image should not prompt");
    },
  );
  expect(status).toBe("present");
  expect(calls).toEqual([["image", "inspect", "example@sha256:digest"]]);
});
