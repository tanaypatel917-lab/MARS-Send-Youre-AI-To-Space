/**
 * @mars/code-refs — committed Git object references over a host-trusted
 * repository mapping. This package performs NO authorization: callers must
 * already have decided that the viewer may see `repo_id`.
 */
export {
  isSameReference,
  type ReferenceIdentity,
  referenceDigest,
} from "./digest";
export {
  createGitRunner,
  GIT_CONFIG_OVERRIDES,
  GIT_GLOBAL_FLAGS,
  type GitChild,
  type GitInvocation,
  type GitResult,
  type GitRunner,
  type GitRunnerOptions,
  type GitSpawn,
  type GitSpawnOptions,
  gitEnvironment,
} from "./git";
export { type LocatorCheck, validateLocator } from "./locator";
export {
  checkLocatorPath,
  hasInvisibleCodePoint,
  INVISIBLE_CODE_POINT_RANGES,
  isInvisibleCodePoint,
  MAX_PATH_LENGTH,
  type PathCheck,
  type PathRejectReason,
  validateLocatorPath,
} from "./path-rules";
export {
  createRepoRegistry,
  type RegisteredRepo,
  type RepoRegistrationError,
  RepoRegistrationFailed,
  type RepoRegistry,
  type RepoRegistryOptions,
} from "./registry";
export { resolveReference, splitLines } from "./resolve";
export * from "./schemas";
export { compareMatches, rankPath, searchPaths } from "./search";
