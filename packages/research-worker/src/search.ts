import { z } from "zod";
import type { FetchLike } from "./net";

export const SearchResultSchema = z
  .object({
    url: z.string().url().max(2048),
    title: z.string().max(512),
    snippet: z.string().max(2048),
  })
  .strict();
export type SearchResult = z.infer<typeof SearchResultSchema>;

export interface SearchOptions {
  limit: number;
  signal: AbortSignal;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

export function normalizeSearchResults(
  rows: unknown,
  pick: (row: Record<string, unknown>) => {
    url: unknown;
    title: unknown;
    snippet: unknown;
  },
  limit: number,
): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const picked = pick(row as Record<string, unknown>);
    const parsed = SearchResultSchema.safeParse({
      url: text(picked.url, 2048),
      title: text(picked.title, 512),
      snippet: text(picked.snippet, 2048),
    });
    if (parsed.success) results.push(parsed.data);
    if (results.length >= limit) break;
  }
  return results;
}

async function fetchJson(
  id: string,
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Search provider ${id} returned HTTP ${response.status}.`);
  }
  return response.json();
}

export function createSearxngSearch(options: {
  baseUrl: string;
  fetch: FetchLike;
}): SearchProvider {
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    id: "searxng",
    async search(query, { limit, signal }) {
      const url = `${base}/search?${new URLSearchParams({
        q: query,
        format: "json",
        safesearch: "1",
      })}`;
      const payload = (await fetchJson(
        "searxng",
        options.fetch,
        url,
        { headers: { accept: "application/json" } },
        signal,
      )) as { results?: unknown };
      return normalizeSearchResults(
        payload.results,
        (row) => ({ url: row.url, title: row.title, snippet: row.content }),
        limit,
      );
    },
  };
}

export function createBraveSearch(options: {
  apiKey: string;
  fetch: FetchLike;
}): SearchProvider {
  return {
    id: "brave",
    async search(query, { limit, signal }) {
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams(
        { q: query, count: String(Math.min(limit, 20)) },
      )}`;
      const payload = (await fetchJson(
        "brave",
        options.fetch,
        url,
        {
          headers: {
            accept: "application/json",
            "x-subscription-token": options.apiKey,
          },
        },
        signal,
      )) as { web?: { results?: unknown } };
      return normalizeSearchResults(
        payload.web?.results,
        (row) => ({ url: row.url, title: row.title, snippet: row.description }),
        limit,
      );
    },
  };
}

export function createTavilySearch(options: {
  apiKey: string;
  fetch: FetchLike;
}): SearchProvider {
  return {
    id: "tavily",
    async search(query, { limit, signal }) {
      const payload = (await fetchJson(
        "tavily",
        options.fetch,
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            query,
            max_results: Math.min(limit, 20),
            include_raw_content: false,
          }),
        },
        signal,
      )) as { results?: unknown };
      return normalizeSearchResults(
        payload.results,
        (row) => ({ url: row.url, title: row.title, snippet: row.content }),
        limit,
      );
    },
  };
}
