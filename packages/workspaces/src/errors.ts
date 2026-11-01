export class WorkspaceError extends Error {
  readonly code: string;

  constructor(
    name: string,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = name;
    this.code = code;
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor() {
    super("WorkspaceNotFoundError", "not_found", "Workspace not found");
  }
}

export class WorkspacePolicyError extends WorkspaceError {
  constructor(message = "Workspace policy rejected the operation") {
    super("WorkspacePolicyError", "policy", message);
  }
}

export class RevisionConflictError extends WorkspaceError {
  constructor() {
    super(
      "RevisionConflictError",
      "revision_conflict",
      "Workspace revision conflict",
    );
  }
}

export class WorkspaceModifiedError extends WorkspaceError {
  constructor() {
    super(
      "WorkspaceModifiedError",
      "workspace_modified",
      "Workspace was modified outside the provider",
    );
  }
}

export class LimitExceededError extends WorkspaceError {
  constructor(message: string) {
    super("LimitExceededError", "limit_exceeded", message);
  }
}

export class CommandNotApprovedError extends WorkspaceError {
  constructor() {
    super(
      "CommandNotApprovedError",
      "command_not_approved",
      "Command was not approved",
    );
  }
}

export class SandboxUnavailableError extends WorkspaceError {
  constructor(message = "Sandbox is unavailable", options?: ErrorOptions) {
    super("SandboxUnavailableError", "sandbox_unavailable", message, options);
  }
}

export class IntegrityError extends WorkspaceError {
  constructor(
    message = "Workspace integrity validation failed",
    options?: ErrorOptions,
  ) {
    super("IntegrityError", "integrity", message, options);
  }
}

export class ProviderLockedError extends WorkspaceError {
  constructor() {
    super(
      "ProviderLockedError",
      "locked",
      "A provider is already using this root directory",
    );
  }
}
