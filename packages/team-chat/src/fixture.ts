import {
  canonicalPair,
  type FixtureDataset,
  FixtureDatasetSchema,
} from "./schemas";

/**
 * Deterministic local fixture for the PR 1 prototype. Every id, SHA, time and
 * body below is invented; the two "repos" are fixture repos whose blobs exist
 * only in this file so the side panel can show exact lines at a pinned
 * revision without any network or Git access. Shown to users as `FIXTURE`.
 */

export const FIXTURE_LABEL = "FIXTURE" as const;

export const FIXTURE_TEAM_ID = "team_fixture";
export const FIXTURE_USERS = {
  ada: "user_ada",
  grace: "user_grace",
  linus: "user_linus",
} as const;
export const FIXTURE_REPOS = {
  platform: "repo_fixture_platform",
  site: "repo_fixture_site",
} as const;
export const FIXTURE_CONVERSATIONS = {
  dmAdaGrace: "conv_dm_ada_grace",
  groupRelease: "conv_group_release",
  dmGraceLinus: "conv_dm_grace_linus",
} as const;

export const PLATFORM_SHA = "3f2c9a1e5b7d4c6a8e0f1a2b3c4d5e6f7a8b9c0d";
export const SITE_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const PLATFORM_SERVICE_TS = [
  "// FIXTURE blob: packages/watch/src/service.ts @ 3f2c9a1 (invented)",
  'import { z } from "zod";',
  "",
  'export type Verdict = "pass" | "fail" | "inconclusive";',
  "",
  "export interface CheckRecord {",
  "  name: string;",
  "  required: boolean;",
  '  status: "passed" | "failed" | "skipped";',
  "}",
  "",
  "export function verdictFor(checks: readonly CheckRecord[]): Verdict {",
  "  const required = checks.filter((check) => check.required);",
  '  if (required.length === 0) return "pass";',
  '  if (required.some((check) => check.status === "failed")) return "fail";',
  '  if (required.some((check) => check.status === "skipped"))',
  '    return "inconclusive";',
  '  return "pass";',
  "}",
  "",
  "export const BadgeSchema = z",
  "  .object({",
  '    verdict: z.enum(["pass", "fail", "inconclusive"]),',
  "    tested_revision: z.string().regex(/^[0-9a-f]{40}$/),",
  "    patch_digest: z.string().regex(/^[0-9a-f]{64}$/),",
  "  })",
  "  .strict();",
  "",
  "export function badgeFor(checks: readonly CheckRecord[], revision: string) {",
  "  return { verdict: verdictFor(checks), tested_revision: revision };",
  "}",
].join("\n");

const PLATFORM_CLIENT_TS = [
  "// FIXTURE blob: apps/vscode/src/client.ts @ 3f2c9a1 (invented)",
  "export interface ArtifactRef {",
  "  artifact_id: string;",
  "  sha256: string;",
  "  media_type: string;",
  "  byte_length: number;",
  "}",
  "",
  "export interface VerifiedArtifact {",
  "  ref: ArtifactRef;",
  "  bytes: Uint8Array;",
  "  media_type: string;",
  "}",
  "",
  "export async function verifyArtifact(",
  "  ref: ArtifactRef,",
  "  bytes: Uint8Array,",
  "  digest: (bytes: Uint8Array) => Promise<string>,",
  "): Promise<VerifiedArtifact> {",
  "  if (bytes.byteLength !== ref.byte_length)",
  '    throw new Error("artifact length mismatch");',
  "  if ((await digest(bytes)) !== ref.sha256)",
  '    throw new Error("artifact hash mismatch");',
  "  return { ref, bytes, media_type: ref.media_type };",
  "}",
].join("\n");

const SITE_STYLE_CSS = [
  "/* FIXTURE blob: src/style.css @ a1b2c3d (invented) */",
  ":root {",
  "  --ink: #f4efe6;",
  "  --dust: #b5542b;",
  "  --banner-height: 56px;",
  "}",
  "",
  "body {",
  "  margin: 0;",
  "  background: #0b0908;",
  "  color: var(--ink);",
  "}",
  "",
  ".banner {",
  "  position: sticky;",
  "  top: 0;",
  "  height: var(--banner-height);",
  "  display: flex;",
  "  align-items: center;",
  "  gap: 12px;",
  "  padding: 0 16px;",
  "  background: rgba(11, 9, 8, 0.8);",
  "}",
  "",
  ".banner .verdict {",
  "  font-variant-numeric: tabular-nums;",
  "}",
].join("\n");

const SITE_HOW_TS = [
  "// FIXTURE blob: src/how.ts @ a1b2c3d (invented)",
  "export type Stage = 0 | 1 | 2 | 3 | 4;",
  "",
  "export function bannerHeight(stage: Stage): number {",
  "  return stage >= 3 ? 72 : 56;",
  "}",
  "",
  "export function stageLabel(stage: Stage): string {",
  '  return ["loop", "observe", "evaluate", "refine", "ascend"][stage] ?? "loop";',
  "}",
].join("\n");

const t = (minute: number) =>
  `2026-11-03T14:${String(minute).padStart(2, "0")}:00.000Z`;

const scope = (repo_id: string) => ({
  team_id: FIXTURE_TEAM_ID,
  repo_id,
});

const raw: FixtureDataset = {
  schema_version: 1,
  label: FIXTURE_LABEL,
  team: { team_id: FIXTURE_TEAM_ID, name: "MARS fixture team" },
  users: [
    { user_id: FIXTURE_USERS.ada, handle: "ada", display_name: "Ada Lin" },
    {
      user_id: FIXTURE_USERS.grace,
      handle: "grace",
      display_name: "Grace Oyelaran",
    },
    {
      user_id: FIXTURE_USERS.linus,
      handle: "linus",
      display_name: "Linus Mbeki",
    },
  ],
  memberships: [
    {
      team_id: FIXTURE_TEAM_ID,
      user_id: FIXTURE_USERS.ada,
      role: "owner",
      state: "active",
    },
    {
      team_id: FIXTURE_TEAM_ID,
      user_id: FIXTURE_USERS.grace,
      role: "member",
      state: "active",
    },
    {
      team_id: FIXTURE_TEAM_ID,
      user_id: FIXTURE_USERS.linus,
      role: "member",
      state: "active",
    },
  ],
  repos: [
    {
      repo_id: FIXTURE_REPOS.platform,
      name: "mars-platform (fixture)",
      default_branch: "main",
    },
    {
      repo_id: FIXTURE_REPOS.site,
      name: "mars-site (fixture)",
      default_branch: "main",
    },
  ],
  repo_access: [
    { user_id: FIXTURE_USERS.ada, repo_id: FIXTURE_REPOS.platform },
    { user_id: FIXTURE_USERS.ada, repo_id: FIXTURE_REPOS.site },
    { user_id: FIXTURE_USERS.grace, repo_id: FIXTURE_REPOS.platform },
    { user_id: FIXTURE_USERS.grace, repo_id: FIXTURE_REPOS.site },
    // Linus can read the platform repo only; site chips are restricted for him.
    { user_id: FIXTURE_USERS.linus, repo_id: FIXTURE_REPOS.platform },
  ],
  blobs: [
    {
      repo_id: FIXTURE_REPOS.platform,
      commit_sha: PLATFORM_SHA,
      path: "packages/watch/src/service.ts",
      text: PLATFORM_SERVICE_TS,
      symbols: [
        { name: "Verdict", line: 4 },
        { name: "CheckRecord", line: 6 },
        { name: "verdictFor", line: 12 },
        { name: "BadgeSchema", line: 21 },
        { name: "badgeFor", line: 29 },
      ],
    },
    {
      repo_id: FIXTURE_REPOS.platform,
      commit_sha: PLATFORM_SHA,
      path: "apps/vscode/src/client.ts",
      text: PLATFORM_CLIENT_TS,
      symbols: [
        { name: "ArtifactRef", line: 2 },
        { name: "VerifiedArtifact", line: 9 },
        { name: "verifyArtifact", line: 15 },
      ],
    },
    {
      repo_id: FIXTURE_REPOS.site,
      commit_sha: SITE_SHA,
      path: "src/style.css",
      text: SITE_STYLE_CSS,
      symbols: [
        { name: "--banner-height", line: 5 },
        { name: ".banner", line: 14 },
        { name: ".banner .verdict", line: 25 },
      ],
    },
    {
      repo_id: FIXTURE_REPOS.site,
      commit_sha: SITE_SHA,
      path: "src/how.ts",
      text: SITE_HOW_TS,
      symbols: [
        { name: "Stage", line: 2 },
        { name: "bannerHeight", line: 4 },
        { name: "stageLabel", line: 8 },
      ],
    },
  ],
  conversations: [
    {
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      team_id: FIXTURE_TEAM_ID,
      kind: "dm",
      title: null,
      canonical_pair: canonicalPair(FIXTURE_USERS.ada, FIXTURE_USERS.grace),
      created_at: t(0),
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      team_id: FIXTURE_TEAM_ID,
      kind: "group",
      title: "Release triage",
      canonical_pair: null,
      created_at: t(1),
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.dmGraceLinus,
      team_id: FIXTURE_TEAM_ID,
      kind: "dm",
      title: null,
      canonical_pair: canonicalPair(FIXTURE_USERS.grace, FIXTURE_USERS.linus),
      created_at: t(2),
    },
  ],
  participants: [
    {
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      user_id: FIXTURE_USERS.ada,
      pinned: true,
      read_cursor: 2,
      joined_at_sequence: 0,
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      user_id: FIXTURE_USERS.grace,
      pinned: false,
      read_cursor: 4,
      joined_at_sequence: 0,
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      user_id: FIXTURE_USERS.ada,
      pinned: false,
      read_cursor: 3,
      joined_at_sequence: 0,
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      user_id: FIXTURE_USERS.grace,
      pinned: true,
      read_cursor: 3,
      joined_at_sequence: 0,
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      user_id: FIXTURE_USERS.linus,
      pinned: false,
      read_cursor: 2,
      joined_at_sequence: 0,
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.dmGraceLinus,
      user_id: FIXTURE_USERS.grace,
      pinned: false,
      read_cursor: 1,
      joined_at_sequence: 0,
    },
    {
      conversation_id: FIXTURE_CONVERSATIONS.dmGraceLinus,
      user_id: FIXTURE_USERS.linus,
      pinned: false,
      read_cursor: 0,
      joined_at_sequence: 0,
    },
  ],
  messages: [
    {
      message_id: "msg_dm_1",
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      author_id: FIXTURE_USERS.grace,
      sequence: 1,
      client_message_id: "cm_grace_0001",
      body: "The verify badge shows green even when the only required check was skipped. Have you seen this?",
      reply_to: null,
      created_at: t(5),
    },
    {
      message_id: "msg_dm_2",
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      author_id: FIXTURE_USERS.ada,
      sequence: 2,
      client_message_id: "cm_ada_0001",
      body: "Yes. verdictFor returns pass when the required list is empty, so a skipped required check never reaches the inconclusive branch.",
      reply_to: "msg_dm_1",
      created_at: t(7),
    },
    {
      message_id: "msg_dm_3",
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      author_id: FIXTURE_USERS.grace,
      sequence: 3,
      client_message_id: "cm_grace_0002",
      body: "Fixing it on a branch with a regression test for the skipped case.",
      reply_to: null,
      created_at: t(12),
    },
    {
      message_id: "msg_dm_4",
      conversation_id: FIXTURE_CONVERSATIONS.dmAdaGrace,
      author_id: FIXTURE_USERS.grace,
      sequence: 4,
      client_message_id: "cm_grace_0003",
      body: "Pushed. Can you check the badge schema still matches the exported verdict union?",
      reply_to: null,
      created_at: t(15),
    },
    {
      message_id: "msg_grp_1",
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      author_id: FIXTURE_USERS.ada,
      sequence: 1,
      client_message_id: "cm_ada_0002",
      body: "Release triage for 0.0.2: the sticky banner height on the site and the artifact verification path in the client.",
      reply_to: null,
      created_at: t(20),
    },
    {
      message_id: "msg_grp_2",
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      author_id: FIXTURE_USERS.linus,
      sequence: 2,
      client_message_id: "cm_linus_0001",
      body: "Both in one place: the banner is the CSS custom property, and the client refuses an artifact when the length or hash differs.",
      reply_to: null,
      created_at: t(23),
    },
    {
      message_id: "msg_grp_3",
      conversation_id: FIXTURE_CONVERSATIONS.groupRelease,
      author_id: FIXTURE_USERS.grace,
      sequence: 3,
      client_message_id: "cm_grace_0004",
      body: "The stage-dependent height lives in how.ts, not the stylesheet; linking it so nobody patches the wrong file.",
      reply_to: "msg_grp_2",
      created_at: t(26),
    },
    {
      message_id: "msg_gl_1",
      conversation_id: FIXTURE_CONVERSATIONS.dmGraceLinus,
      author_id: FIXTURE_USERS.grace,
      sequence: 1,
      client_message_id: "cm_grace_0005",
      body: "Private to this DM: Ada must never see this body through any read path.",
      reply_to: null,
      created_at: t(30),
    },
  ],
  reactions: [
    { message_id: "msg_dm_2", user_id: FIXTURE_USERS.grace, emoji: "✅" },
    { message_id: "msg_dm_3", user_id: FIXTURE_USERS.ada, emoji: "👍" },
    { message_id: "msg_grp_2", user_id: FIXTURE_USERS.ada, emoji: "👀" },
    { message_id: "msg_grp_2", user_id: FIXTURE_USERS.grace, emoji: "👀" },
  ],
  references: [
    {
      reference_id: "ref_platform_verdict",
      kind: "range",
      repo_id: FIXTURE_REPOS.platform,
      commit_sha: PLATFORM_SHA,
      path: "packages/watch/src/service.ts",
      line_start: 12,
      line_end: 19,
      symbol: null,
      access_scope: scope(FIXTURE_REPOS.platform),
    },
    {
      reference_id: "ref_site_banner",
      kind: "range",
      repo_id: FIXTURE_REPOS.site,
      commit_sha: SITE_SHA,
      path: "src/style.css",
      line_start: 14,
      line_end: 23,
      symbol: null,
      access_scope: scope(FIXTURE_REPOS.site),
    },
    {
      reference_id: "ref_platform_verify",
      kind: "symbol",
      repo_id: FIXTURE_REPOS.platform,
      commit_sha: PLATFORM_SHA,
      path: "apps/vscode/src/client.ts",
      line_start: 15,
      line_end: 25,
      symbol: "verifyArtifact",
      access_scope: scope(FIXTURE_REPOS.platform),
    },
    {
      reference_id: "ref_site_how",
      kind: "file",
      repo_id: FIXTURE_REPOS.site,
      commit_sha: SITE_SHA,
      path: "src/how.ts",
      line_start: null,
      line_end: null,
      symbol: null,
      access_scope: scope(FIXTURE_REPOS.site),
    },
  ],
  shares: [
    { message_id: "msg_dm_2", reference_id: "ref_platform_verdict" },
    { message_id: "msg_grp_2", reference_id: "ref_site_banner" },
    { message_id: "msg_grp_2", reference_id: "ref_platform_verify" },
    { message_id: "msg_grp_3", reference_id: "ref_site_how" },
  ],
};

/** The validated fixture. Parsing at module load keeps the fixture honest. */
export const FIXTURE: FixtureDataset = FixtureDatasetSchema.parse(raw);

/** Deep copy so a service instance can mutate without touching the module constant. */
export function cloneFixture(
  dataset: FixtureDataset = FIXTURE,
): FixtureDataset {
  return structuredClone(dataset);
}
