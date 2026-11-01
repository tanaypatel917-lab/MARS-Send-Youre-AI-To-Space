import { afterAll, describe, expect, test } from "bun:test";
import { checkServerUrl } from "../src/endpoint";
import {
  type FetchLike,
  HttpRpcTransport,
  RpcError,
  sanitizeServerText,
} from "../src/rpc";

const TOKEN = "dummy-token-not-real";
type Init = Parameters<FetchLike>[1];

function reply(
  status: number,
  body: unknown,
  contentType = "application/json",
): ReturnType<FetchLike> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve({
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    text: () => Promise.resolve(text),
  });
}

function transport(
  fetch: FetchLike,
  token: string | null = TOKEN,
  timeoutMs = 1000,
) {
  return new HttpRpcTransport({
    rpcUrl: "http://127.0.0.1:7331/v1/rpc",
    getToken: () => Promise.resolve(token ?? undefined),
    fetch,
    timeoutMs,
  });
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected rejection");
}

describe("HttpRpcTransport", () => {
  test("sends bearer auth, JSON body and refuses redirects; describe has no context", async () => {
    const seen: Array<{ url: string; init: Init }> = [];
    const t = transport((url, init) => {
      seen.push({ url, init });
      return reply(200, { result: { ok: 1 } });
    });
    expect(await t.send({ method: "workbench.describe", params: {} })).toEqual({
      ok: 1,
    });
    const first = seen[0];
    expect(first?.url).toBe("http://127.0.0.1:7331/v1/rpc");
    expect(first?.init.method).toBe("POST");
    expect(first?.init.redirect).toBe("error");
    expect(first?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(first?.init.body ?? "")).toEqual({
      method: "workbench.describe",
      params: {},
    });

    const context = {
      schema_version: 1 as const,
      scope: { owner_id: "o", project_id: "p" },
      request_id: "r1",
    };
    await t.send({ method: "tasks.list", context, params: {} });
    expect(JSON.parse(seen[1]?.init.body ?? "")).toEqual({
      method: "tasks.list",
      context,
      params: {},
    });
  });

  test("never sends a request without a token", async () => {
    let called = false;
    const t = transport(() => {
      called = true;
      return reply(200, { result: null });
    }, null);
    expect(
      (await rejection(t.send({ method: "tasks.list", params: {} }))).kind,
    ).toBe("no-token");
    expect(called).toBe(false);
  });

  test("maps RPC errors and HTTP statuses", async () => {
    const cases: Array<[number, unknown, string]> = [
      [
        200,
        { error: { code: "revision_conflict", message: "stale" } },
        "conflict",
      ],
      [409, { error: { code: "conflict", message: "stale" } }, "conflict"],
      [
        401,
        { error: { code: "unauthorized", message: "bad token" } },
        "unauthorized",
      ],
      [403, "nope", "forbidden"],
      [404, { error: { code: "not_found", message: "missing" } }, "not-found"],
      [500, "<html>boom</html>", "server"],
      [200, { error: { code: "internal", message: "x" } }, "server"],
    ];
    for (const [status, body, kind] of cases) {
      const contentType =
        typeof body === "string" ? "text/html" : "application/json";
      const error = await rejection(
        transport(() => reply(status, body, contentType)).send({
          method: "tasks.list",
          params: {},
        }),
      );
      expect(error.kind).toBe(kind as RpcError["kind"]);
    }
  });

  test("malformed or unknown responses are protocol errors", async () => {
    for (const body of [
      { result: 1, extra: true },
      { nothing: true },
      { error: { code: 1 } },
      { error: { code: "x", message: "y", more: 1 } },
      "[]",
      "not json",
    ]) {
      const error = await rejection(
        transport(() => reply(200, body)).send({
          method: "tasks.list",
          params: {},
        }),
      );
      expect(error.kind).toBe("protocol");
    }
    const html = await rejection(
      transport(() => reply(200, '{"result":1}', "text/html")).send({
        method: "tasks.list",
        params: {},
      }),
    );
    expect(html.kind).toBe("protocol");
  });

  test("redacts the token and strips control characters from server text", async () => {
    const error = await rejection(
      transport(() =>
        reply(400, {
          error: { code: "bad", message: `echo ${TOKEN}\u001b[31m` },
        }),
      ).send({ method: "tasks.list", params: {} }),
    );
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("\u001b");
    expect(sanitizeServerText("x".repeat(2000)).length).toBeLessThanOrEqual(
      501,
    );
  });

  test("network failure, timeout and caller cancellation", async () => {
    const down = await rejection(
      transport(() => Promise.reject(new TypeError("ECONNREFUSED"))).send({
        method: "tasks.list",
        params: {},
      }),
    );
    expect(down.kind).toBe("disconnected");

    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    const timeout = await rejection(
      transport(hang, TOKEN, 20).send({ method: "tasks.list", params: {} }),
    );
    expect(timeout.kind).toBe("timeout");

    const controller = new AbortController();
    const pending = transport(hang).send(
      { method: "tasks.list", params: {} },
      controller.signal,
    );
    controller.abort();
    expect((await rejection(pending)).kind).toBe("cancelled");
  });
});

describe("loopback HTTP stub", () => {
  const seen: Array<{ auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      seen.push({ auth: request.headers.get("authorization"), body });
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`)
        return Response.json(
          { error: { code: "unauthorized", message: "no" } },
          { status: 401 },
        );
      return Response.json({
        result: { echoed: (body as { method: string }).method },
      });
    },
  });
  afterAll(() => server.stop(true));

  test("round-trips through a real loopback server with a dummy token", async () => {
    const endpoint = checkServerUrl(`http://127.0.0.1:${server.port}`, false);
    if (!endpoint.ok) throw new Error(endpoint.reason);
    const ok = new HttpRpcTransport({
      rpcUrl: endpoint.rpcUrl,
      getToken: async () => TOKEN,
    });
    expect(await ok.send({ method: "workbench.describe", params: {} })).toEqual(
      { echoed: "workbench.describe" },
    );
    const bad = new HttpRpcTransport({
      rpcUrl: endpoint.rpcUrl,
      getToken: async () => "wrong-dummy",
    });
    expect(
      (await rejection(bad.send({ method: "workbench.describe", params: {} })))
        .kind,
    ).toBe("unauthorized");
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });
});

describe("bounded response bodies", () => {
  function streamed(chunks: Uint8Array[], onCancel: () => void) {
    return () =>
      Promise.resolve({
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        text: () => Promise.reject(new Error("text() must not be used")),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
          cancel: onCancel,
        }),
      });
  }

  test("stops reading once an undeclared-length body exceeds the limit", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024).fill(0x20);
    const t = new HttpRpcTransport({
      rpcUrl: "http://127.0.0.1:7331/v1/rpc",
      getToken: () => Promise.resolve(TOKEN),
      fetch: streamed([chunk, chunk, chunk, chunk], () => {
        cancelled = true;
      }),
      maxResponseBytes: 2048,
    });
    const error = await rejection(t.send({ method: "tasks.list", params: {} }));
    expect(error.kind).toBe("protocol");
    expect(error.message).toContain("too large");
    expect(cancelled).toBe(true);
  });

  test("streamed bodies under the limit are decoded across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('{"result":"héllo"}');
    const t = new HttpRpcTransport({
      rpcUrl: "http://127.0.0.1:7331/v1/rpc",
      getToken: () => Promise.resolve(TOKEN),
      fetch: streamed([bytes.slice(0, 13), bytes.slice(13)], () => {}),
      maxResponseBytes: 2048,
    });
    expect(await t.send({ method: "tasks.list", params: {} })).toBe("héllo");
  });
});
