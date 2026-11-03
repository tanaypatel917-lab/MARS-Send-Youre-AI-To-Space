import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SkillLifecycleService } from "@mars/contracts";
import { scanThreat } from "@mars/memory";
import { parseFrontmatter } from "./frontmatter";
import { withDirectoryLock } from "./lock";

export interface MutationOptions {
  actor: string;
  source: string;
  expectedRevision?: string;
  reviewId?: string;
}
export type Status = "active" | "stale" | "archived";
export interface Skill {
  name: string;
  content: string;
  status: Status;
  pinned: boolean;
  createdAt: number;
  lastActivity: number;
  useCount: number;
}
export interface Version {
  id: string;
  ts: string;
  op: string;
  skill: Skill;
}
export interface Draft {
  id: string;
  name: string;
  content: string;
  rationale: string;
  ts: string;
  baseRevision: string;
}
export type Operation = { name: string } & (
  | { op: "create"; content: string }
  | { op: "update"; content: string }
  | { op: "archive" | "restore" | "recordUse" | "stale" }
  | { op: "pin"; pinned: boolean }
  | { op: "restoreVersion"; versionId: string }
);
export interface Proposal {
  id: string;
  source: string;
  ops: Operation[];
  rationale: string;
  expectedRevision: string;
  status: "pending" | "accepted" | "rejected";
  reason?: string;
}
export interface Change {
  ts: string;
  actor: string;
  source: string;
  op: string;
  skill: string | null;
  revisionBefore: string;
  revisionAfter: string;
  reviewId: string | null;
  before?: Skill;
  after?: Skill;
  draftsBefore?: Draft[];
  draftsAfter?: Draft[];
}
interface State {
  skills: Record<string, Skill>;
  versions: Record<string, Version[]>;
  drafts: Draft[];
  proposals: Proposal[];
  undone: string[];
}
interface Transaction {
  state: State;
  journal: string;
}
export class SkillError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
  }
}
function fail(code: string, message: string): never {
  throw new SkillError(code, message);
}
function validateName(name: string) {
  if (
    typeof name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
    ["constructor", "prototype"].includes(name)
  )
    fail(
      "invalid-name",
      "Skill names must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit (reserved object names excluded)",
    );
}
function validateContent(name: string, content: string) {
  validateName(name);
  if (typeof content !== "string" || !content.trim())
    fail("invalid-content", "Skill content is required");
  const data = parseFrontmatter(content);
  if (!data) fail("frontmatter", "Valid YAML frontmatter is required");
  if (data.name !== name || !data.description?.trim())
    fail(
      "frontmatter",
      "Frontmatter name must match the skill and description must be nonempty",
    );
  const threat = scanThreat(content);
  if (threat) fail("threat", `Blocked: ${threat}`);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const revision = (state: State) =>
  digest({
    skills: state.skills,
    versions: state.versions,
    drafts: state.drafts,
    undone: state.undone,
  });
const contentRevision = (skill?: Skill) => digest(skill?.content ?? null);
const fresh = (): State => ({
  skills: {},
  versions: {},
  drafts: [],
  proposals: [],
  undone: [],
});

export class SkillStore implements SkillLifecycleService {
  readonly root: string;
  private readonly clock: () => number;
  constructor(root: string, options: { clock?: () => number } = {}) {
    this.root = resolve(root);
    this.clock = options.clock ?? Date.now;
  }

  private async safe(relative: string) {
    const path = resolve(this.root, relative);
    if (!path.startsWith(this.root + sep))
      fail("unsafe-path", "Path escapes root");
    let current = this.root;
    for (const part of relative.split(sep)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          fail("unsafe-path", "Symlinks are not allowed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return path;
  }
  private location(skill: Skill) {
    validateName(skill.name);
    return join(
      "skills",
      ...(skill.status === "archived" ? [".archive"] : []),
      skill.name,
    );
  }
  private async read(relative: string) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readFile(await this.safe(relative)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async exists(relative: string) {
    try {
      await lstat(await this.safe(relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async syncParents(path: string) {
    for (
      let current = path;
      current.startsWith(this.root);
      current = dirname(current)
    ) {
      const directory = await open(current, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      if (current === this.root) break;
    }
  }
  private async atomic(relative: string, text: string) {
    const path = await this.safe(relative);
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.write-${randomUUID()}`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    await this.syncParents(dirname(path));
  }
  private async recover() {
    const pending = await this.read(".skills-transaction.json");
    if (!pending) return;
    const tx = JSON.parse(pending) as Transaction;
    for (const skill of Object.values(tx.state.skills)) {
      validateContent(skill.name, skill.content);
      const destination = this.location(skill);
      const other = this.location({
        ...skill,
        status: skill.status === "archived" ? "active" : "archived",
      });
      if (await this.exists(other)) {
        if (await this.exists(destination))
          fail("conflict", "Both archived and live skill directories exist");
        const path = await this.safe(destination);
        await mkdir(dirname(path), { recursive: true });
        const source = await this.safe(other);
        await rename(source, path);
        await this.syncParents(dirname(source));
        await this.syncParents(dirname(path));
      }
      if ((await this.read(join(destination, "SKILL.md"))) !== skill.content)
        await this.atomic(join(destination, "SKILL.md"), skill.content);
    }
    const metadata = {
      ...tx.state,
      skills: Object.fromEntries(
        Object.entries(tx.state.skills).map(
          ([name, { content: _, ...skill }]) => [name, skill],
        ),
      ),
    };
    await this.atomic(".lifecycle.json", JSON.stringify(metadata));
    await this.atomic("changes.jsonl", tx.journal);
    await rm(await this.safe(".skills-transaction.json"));
  }
  private async load(): Promise<State> {
    const state = JSON.parse(
      (await this.read(".lifecycle.json")) ?? JSON.stringify(fresh()),
    ) as State;
    for (const [name, skill] of Object.entries(state.skills)) {
      validateName(name);
      if (skill.name !== name) fail("corrupt", "Skill metadata name mismatch");
      const content = await this.read(join(this.location(skill), "SKILL.md"));
      if (content === undefined)
        fail("missing", `Missing SKILL.md for ${name}`);
      validateContent(name, content);
      skill.content = content;
    }
    return state;
  }
  private locked<T>(action: (state: State) => Promise<T>) {
    return withDirectoryLock(this.root, async () => {
      await this.recover();
      return action(await this.load());
    });
  }
  private check(state: State, options: MutationOptions) {
    if (!options.actor?.trim() || !options.source?.trim())
      fail("invalid", "actor and source are required");
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== revision(state)
    )
      fail("stale-revision", "Skill store changed since expectedRevision");
  }
  private log(
    state: State,
    options: MutationOptions,
    op: string,
    skill: string | null,
    beforeRevision: string,
    before?: Skill,
  ): Change {
    return {
      ts: new Date(this.clock()).toISOString(),
      actor: options.actor,
      source: options.source,
      op,
      skill,
      revisionBefore: beforeRevision,
      revisionAfter: revision(state),
      reviewId: options.reviewId ?? null,
      ...(before ? { before: structuredClone(before) } : {}),
      ...(skill && state.skills[skill]
        ? { after: structuredClone(state.skills[skill]) }
        : {}),
    };
  }
  private async commit(state: State, changes: Change[]) {
    const previous = JSON.parse(
      (await this.read(".lifecycle.json")) ?? JSON.stringify(fresh()),
    ) as State;
    for (const skill of Object.values(state.skills)) {
      validateContent(skill.name, skill.content);
      const destination = this.location(skill);
      const other = this.location({
        ...skill,
        status: skill.status === "archived" ? "active" : "archived",
      });
      await this.safe(join(destination, "SKILL.md"));
      await this.safe(join(other, "SKILL.md"));
      const destinationExists = await this.exists(destination),
        otherExists = await this.exists(other);
      if (
        (!previous.skills[skill.name] && (destinationExists || otherExists)) ||
        (destinationExists && otherExists)
      )
        fail("conflict", "Unmanaged or conflicting skill directories exist");
    }
    const journal =
      ((await this.read("changes.jsonl")) ?? "") +
      changes.map((c) => `${JSON.stringify(c)}\n`).join("");
    await this.atomic(
      ".skills-transaction.json",
      JSON.stringify({ state, journal }),
    );
    await this.recover();
    return revision(state);
  }
  private snapshot(state: State, skill: Skill, op: string) {
    state.versions[skill.name] ??= [];
    const versions = state.versions[skill.name] ?? [];
    versions.unshift({
      id: randomUUID(),
      ts: new Date(this.clock()).toISOString(),
      op,
      skill: structuredClone(skill),
    });
    versions.splice(10);
  }
  private perform(
    state: State,
    op: Operation,
    options: MutationOptions,
  ): Change {
    validateName(op.name);
    const beforeRevision = revision(state);
    const existing = state.skills[op.name];
    const before = existing && structuredClone(existing);
    if (op.op === "create") {
      if (existing) fail("exists", "Skill already exists (possibly archived)");
      validateContent(op.name, op.content);
      state.skills[op.name] = {
        name: op.name,
        content: op.content,
        status: "active",
        pinned: false,
        createdAt: this.clock(),
        lastActivity: this.clock(),
        useCount: 0,
      };
    } else {
      if (!existing) fail("not-found", "Skill not found");
      if (
        op.op !== "restore" &&
        op.op !== "restoreVersion" &&
        existing.status === "archived"
      )
        fail("archived", "Restore the skill first");
      if (op.op === "update" || op.op === "restoreVersion") {
        const content =
          op.op === "update"
            ? op.content
            : state.versions[op.name]?.find((v) => v.id === op.versionId)?.skill
                .content;
        if (content === undefined) fail("not-found", "Version not found");
        validateContent(op.name, content);
        this.snapshot(state, existing, op.op);
        existing.content = content;
        existing.lastActivity = this.clock();
        existing.status = "active";
      } else if (op.op === "archive") {
        if (existing.pinned) fail("pinned", "Pinned skills cannot be archived");
        this.snapshot(state, existing, op.op);
        existing.status = "archived";
      } else if (op.op === "restore") {
        if (existing.status !== "archived")
          fail("invalid-state", "Skill is not archived");
        this.snapshot(state, existing, op.op);
        existing.status = "active";
        existing.lastActivity = this.clock();
      } else if (op.op === "recordUse") {
        existing.useCount++;
        existing.lastActivity = this.clock();
        existing.status = "active";
      } else if (op.op === "pin") {
        if (typeof op.pinned !== "boolean")
          fail("invalid", "pinned must be boolean");
        existing.pinned = op.pinned;
      } else if (op.op === "stale") {
        if (existing.pinned)
          fail("pinned", "Pinned skills cannot be marked stale");
        existing.status = "stale";
      } else fail("invalid", "Unknown operation");
    }
    return this.log(state, options, op.op, op.name, beforeRevision, before);
  }

  getRevision() {
    return this.locked(async (state) => revision(state));
  }
  get(name: string) {
    return this.locked(async (state) => {
      validateName(name);
      return structuredClone(state.skills[name] ?? null);
    });
  }
  list() {
    return this.locked(async (state) =>
      structuredClone(Object.values(state.skills)),
    );
  }
  applyBatch(ops: Operation[], options: MutationOptions) {
    const copied = structuredClone(ops),
      metadata = { ...options };
    return this.locked(async (state) => {
      this.check(state, metadata);
      if (!Array.isArray(copied) || !copied.length)
        fail("empty", "Batch must not be empty");
      for (const op of copied) {
        validateName(op.name);
        if (
          op.op === "create" &&
          !state.skills[op.name] &&
          ((await this.exists(join("skills", op.name))) ||
            (await this.exists(join("skills", ".archive", op.name))))
        )
          fail("exists", "Unmanaged skill directory already exists");
      }
      const changes = copied.map((op) => this.perform(state, op, metadata));
      return this.commit(state, changes);
    });
  }
  create(name: string, content: string, options: MutationOptions) {
    return this.applyBatch([{ op: "create", name, content }], options);
  }
  update(name: string, content: string, options: MutationOptions) {
    return this.applyBatch([{ op: "update", name, content }], options);
  }
  archive(name: string, options: MutationOptions) {
    return this.applyBatch([{ op: "archive", name }], options);
  }
  restore(name: string, options: MutationOptions) {
    return this.applyBatch([{ op: "restore", name }], options);
  }
  pin(name: string, pinned: boolean, options: MutationOptions) {
    return this.applyBatch([{ op: "pin", name, pinned }], options);
  }
  recordUse(
    name: string,
    options: MutationOptions = { actor: "runtime", source: "usage" },
  ) {
    return this.applyBatch([{ op: "recordUse", name }], options);
  }
  listVersions(name: string) {
    return this.locked(async (state) => {
      validateName(name);
      return structuredClone(state.versions[name] ?? []);
    });
  }
  restoreVersion(name: string, versionId: string, options: MutationOptions) {
    return this.applyBatch(
      [{ op: "restoreVersion", name, versionId }],
      options,
    );
  }

  saveDraft(
    name: string,
    content: string,
    options: MutationOptions,
    rationale = "",
  ) {
    return this.locked(async (state) => {
      this.check(state, options);
      validateContent(name, content);
      if (state.drafts.length >= 50) fail("full", "Draft inbox is full (50)");
      const before = revision(state);
      const draftsBefore = structuredClone(state.drafts);
      const draft: Draft = {
        id: randomUUID(),
        name,
        content,
        rationale,
        ts: new Date(this.clock()).toISOString(),
        baseRevision: contentRevision(state.skills[name]),
      };
      state.drafts.push(draft);
      await this.commit(state, [
        {
          ...this.log(state, options, "saveDraft", name, before),
          draftsBefore,
          draftsAfter: structuredClone(state.drafts),
        },
      ]);
      return structuredClone(draft);
    });
  }
  viewDraft(id: string) {
    return this.locked(async (state) =>
      structuredClone(state.drafts.find((d) => d.id === id) ?? null),
    );
  }
  listDrafts() {
    return this.locked(async (state) => structuredClone(state.drafts));
  }
  discardDraft(id: string, options: MutationOptions) {
    return this.locked(async (state) => {
      this.check(state, options);
      const draft = state.drafts.find((d) => d.id === id);
      if (!draft) fail("not-found", "Draft not found");
      const before = revision(state);
      const draftsBefore = structuredClone(state.drafts);
      state.drafts = state.drafts.filter((d) => d.id !== id);
      return this.commit(state, [
        {
          ...this.log(state, options, "discardDraft", draft.name, before),
          draftsBefore,
          draftsAfter: structuredClone(state.drafts),
        },
      ]);
    });
  }
  applyDraft(id: string, options: MutationOptions) {
    return this.locked(async (state) => {
      this.check(state, options);
      const draft = state.drafts.find((d) => d.id === id);
      if (!draft) fail("not-found", "Draft not found");
      if (draft.baseRevision !== contentRevision(state.skills[draft.name]))
        fail("stale-revision", "Skill changed since draft was saved");
      const draftsBefore = structuredClone(state.drafts);
      const change = this.perform(
        state,
        {
          op: state.skills[draft.name] ? "update" : "create",
          name: draft.name,
          content: draft.content,
        },
        options,
      );
      state.drafts = state.drafts.filter((d) => d.id !== id);
      change.revisionAfter = revision(state);
      change.draftsBefore = draftsBefore;
      change.draftsAfter = structuredClone(state.drafts);
      return this.commit(state, [change]);
    });
  }

  runCurator(
    options: MutationOptions = { actor: "curator", source: "curator" },
  ) {
    return this.locked(async (state) => {
      this.check(state, options);
      const changes: Change[] = [];
      for (const skill of Object.values(state.skills)) {
        if (skill.pinned || skill.status === "archived") continue;
        const days = (this.clock() - skill.lastActivity) / 86_400_000;
        if (days >= 30)
          changes.push(
            this.perform(state, { op: "archive", name: skill.name }, options),
          );
        else if (days >= 14 && skill.status === "active")
          changes.push(
            this.perform(state, { op: "stale", name: skill.name }, options),
          );
      }
      if (changes.length) await this.commit(state, changes);
      return changes;
    });
  }
  undoReview(reviewId: string, options: MutationOptions) {
    return this.locked(async (state) => {
      this.check(state, options);
      if (!reviewId.trim()) fail("invalid", "reviewId is required");
      if (state.undone.includes(reviewId)) return [];
      const history: Change[] = ((await this.read("changes.jsonl")) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Change);
      const skillOps = [
        "create",
        "update",
        "archive",
        "restore",
        "restoreVersion",
        "recordUse",
        "pin",
        "stale",
      ];
      const reviewed = history.filter(
        (c) =>
          c.reviewId === reviewId &&
          (c.draftsAfter || (c.after && skillOps.includes(c.op))),
      );
      if (!reviewed.length)
        fail("not-found", "No skill changes for this review");
      const changes: Change[] = [];
      const undoOptions = { ...options, reviewId: `undo:${reviewId}` };
      for (const change of reviewed.toReversed()) {
        const name = change.skill;
        const beforeRevision = revision(state);
        let before: Skill | undefined;
        if (name && skillOps.includes(change.op)) {
          const current = state.skills[name];
          if (!current || digest(current) !== digest(change.after))
            fail("conflict", `Skill ${name} changed after the review`);
          before = structuredClone(current);
          this.snapshot(state, before, "undoReview");
          const restored: Skill = change.before
            ? structuredClone(change.before)
            : { ...before, status: "archived" };
          state.skills[name] = restored;
          validateContent(name, restored.content);
        }
        if (change.draftsAfter) {
          if (digest(state.drafts) !== digest(change.draftsAfter))
            fail("conflict", "Draft inbox changed after the review");
          state.drafts = structuredClone(change.draftsBefore ?? []);
        }
        changes.push(
          this.log(
            state,
            undoOptions,
            "undoReview",
            name,
            beforeRevision,
            before,
          ),
        );
      }
      state.undone.push(reviewId);
      const last = changes.at(-1);
      if (last) last.revisionAfter = revision(state);
      await this.commit(state, changes);
      return changes;
    });
  }

  submitProposal(
    input: { source: string; ops: Operation[]; rationale: string },
    options?: MutationOptions,
  ) {
    const data = structuredClone(input);
    return this.locked(async (state) => {
      const metadata = options ?? { actor: data.source, source: data.source };
      this.check(state, metadata);
      if (!data.source?.trim() || !data.rationale?.trim() || !data.ops?.length)
        fail("invalid", "source, rationale and ops are required");
      const preview = structuredClone(state);
      for (const op of data.ops) this.perform(preview, op, metadata);
      const proposal: Proposal = {
        ...data,
        id: randomUUID(),
        status: "pending",
        expectedRevision: revision(state),
      };
      state.proposals.push(proposal);
      await this.commit(state, [
        this.log(state, metadata, "submitProposal", null, revision(state)),
      ]);
      return structuredClone(proposal);
    });
  }
  listProposals() {
    return this.locked(async (state) => structuredClone(state.proposals));
  }
  accept(id: string, input: MutationOptions | string) {
    const options =
      typeof input === "string" ? { actor: input, source: "review" } : input;
    return this.locked(async (state) => {
      this.check(state, options);
      const proposal = state.proposals.find((p) => p.id === id);
      if (!proposal || proposal.status !== "pending")
        fail("not-pending", "Proposal is not pending");
      if (proposal.expectedRevision !== revision(state))
        fail("stale-revision", "Skill store changed since proposal");
      const metadata = { ...options, source: proposal.source };
      const changes = proposal.ops.map((op) =>
        this.perform(state, op, metadata),
      );
      proposal.status = "accepted";
      return this.commit(state, changes);
    });
  }
  reject(
    id: string,
    reason: string,
    options: MutationOptions = { actor: "reviewer", source: "review" },
  ) {
    return this.locked(async (state) => {
      this.check(state, options);
      const proposal = state.proposals.find((p) => p.id === id);
      if (!proposal || proposal.status !== "pending")
        fail("not-pending", "Proposal is not pending");
      if (!reason.trim()) fail("invalid", "Rejection reason required");
      const before = revision(state);
      proposal.status = "rejected";
      proposal.reason = reason;
      return this.commit(state, [
        this.log(state, options, "rejectProposal", null, before),
      ]);
    });
  }
}
