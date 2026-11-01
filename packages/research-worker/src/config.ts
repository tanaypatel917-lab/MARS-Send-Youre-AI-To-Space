import { z } from "zod";

const hostPattern = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+$/i);

export const ResearchWorkerConfigSchema = z
  .object({
    live: z.boolean().default(false),
    paid_consent: z.boolean().default(false),
    model: z.string().min(1).optional(),
    user_agent: z
      .string()
      .min(1)
      .max(256)
      .default(
        "MARSResearchWorker/0.1 (+https://github.com/tanaypatel917-lab)",
      ),
    breadth: z.number().int().min(1).max(8).default(3),
    max_depth: z.number().int().min(0).max(4).default(1),
    max_results_per_query: z.number().int().min(1).max(10).default(5),
    max_pages_per_query: z.number().int().min(1).max(10).default(3),
    max_page_bytes: z
      .number()
      .int()
      .min(1024)
      .max(8 * 1024 * 1024)
      .default(1024 * 1024),
    max_text_chars: z.number().int().min(500).max(200_000).default(16_000),
    max_claims_per_page: z.number().int().min(1).max(10).default(4),
    max_findings: z.number().int().min(1).max(32).default(8),
    max_model_output_tokens: z.number().int().min(64).max(8192).default(1024),
    max_redirects: z.number().int().min(0).max(10).default(5),
    per_host_min_interval_ms: z.number().int().min(0).default(1000),
    respect_robots: z.boolean().default(true),
    allow_hosts: z.array(hostPattern).max(256).optional(),
    deny_hosts: z.array(hostPattern).max(1024).default([]),
    deadline_margin_ms: z.number().int().min(0).default(5000),
    private_needles: z.array(z.string().min(1)).max(64).default([]),
  })
  .strict();

export type ResearchWorkerConfigInput = z.input<
  typeof ResearchWorkerConfigSchema
>;
export type ResearchWorkerConfig = z.output<typeof ResearchWorkerConfigSchema>;

export function parseResearchWorkerConfig(
  input: unknown = {},
): ResearchWorkerConfig {
  return ResearchWorkerConfigSchema.parse(input);
}
