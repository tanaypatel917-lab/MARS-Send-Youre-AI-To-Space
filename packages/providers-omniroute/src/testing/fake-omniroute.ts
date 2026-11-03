/**
 * Offline stand-in for an OmniRoute gateway: loopback only, OpenAI-compatible
 * `/v1/models` and `/v1/chat/completions`, records every request so tests can
 * assert headers and that MCP/A2A endpoints are never touched. It never
 * contacts any upstream provider.
 */
export interface FakeModel {
  id: string;
  tool_calling?: boolean;
  vision?: boolean;
  context_length?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeOmniRouteOptions {
  models?: FakeModel[];
  /** When set, `/v1/*` requires `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  reply?: string;
}

export interface FakeOmniRoute {
  /** Origin URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  requests: RecordedRequest[];
  stop(): Promise<void>;
}

const SENSITIVE = new Set(["authorization", "cookie"]);

export async function startFakeOmniRoute(
  options: FakeOmniRouteOptions = {},
): Promise<FakeOmniRoute> {
  const models = options.models ?? [];
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = SENSITIVE.has(name) ? "<redacted>" : value;
      });
      const body =
        request.method === "POST"
          ? await request.json().catch(() => undefined)
          : undefined;
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body,
      });
      if (
        options.apiKey &&
        url.pathname.startsWith("/v1/") &&
        request.headers.get("authorization") !== `Bearer ${options.apiKey}`
      )
        return Response.json(
          { error: { message: "Unauthorized", type: "auth" } },
          { status: 401 },
        );
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const wanted = url.searchParams.getAll("capability");
        const data = models
          .filter((model) =>
            wanted.every(
              (capability) =>
                (capability === "tool_calling" && model.tool_calling) ||
                (capability === "vision" && model.vision),
            ),
          )
          .map((model) => ({
            id: model.id,
            object: "model",
            owned_by: model.id.split("/")[0],
            capabilities: {
              tool_calling: model.tool_calling === true,
              vision: model.vision === true,
            },
            ...(model.context_length
              ? { context_length: model.context_length }
              : {}),
          }));
        return Response.json({ object: "list", data });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/chat/completions"
      ) {
        const requested =
          typeof body === "object" && body !== null
            ? (body as { model?: unknown; stream?: unknown })
            : {};
        const model =
          typeof requested.model === "string" ? requested.model : "";
        if (!models.some((candidate) => candidate.id === model))
          return Response.json(
            { error: { message: `Unknown model ${model}`, type: "invalid" } },
            { status: 404 },
          );
        const content = options.reply ?? `fake reply from ${model}`;
        if (requested.stream === true) {
          const chunk = (delta: Record<string, unknown>, finish?: string) =>
            `data: ${JSON.stringify({
              id: "fake",
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            })}\n\n`;
          const stream = [
            chunk({ role: "assistant", content }),
            chunk({}, "stop"),
            "data: [DONE]\n\n",
          ].join("");
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "fake",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        });
      }
      return Response.json(
        { error: { message: "Not found" } },
        { status: 404 },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    async stop() {
      await server.stop(true);
    },
  };
}
