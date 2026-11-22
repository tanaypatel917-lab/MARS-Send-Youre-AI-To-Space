import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request: {
    id?: number | string;
    method?: string;
    params?: { name?: string };
  };
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (!request || request.id === undefined) continue;
  const { id, method, params } = request;
  let result: unknown;
  if (method === "initialize") {
    result = {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "mars-utc-clock", version: "1.0.0" },
    };
  } else if (method === "tools/list") {
    result = {
      tools: [
        {
          name: "utc_now",
          description: "Return the current time in UTC, in ISO 8601 format.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
  } else if (method === "tools/call" && params?.name === "utc_now") {
    result = { content: [{ type: "text", text: new Date().toISOString() }] };
  } else if (method === "ping") {
    result = {};
  } else {
    console.log(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unknown method or tool" },
      }),
    );
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
