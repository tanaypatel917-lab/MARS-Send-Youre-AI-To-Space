export class ContextError extends Error {
  readonly code: string;

  constructor(name: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export class ContextPolicyError extends ContextError {
  constructor(message = "Repository map policy rejected the request") {
    super("ContextPolicyError", "policy", message);
  }
}

export class ContextRevisionError extends ContextError {
  constructor() {
    super(
      "ContextRevisionError",
      "revision_conflict",
      "Workspace revision does not match",
    );
  }
}

export class ContextCancelledError extends ContextError {
  constructor() {
    super("ContextCancelledError", "cancelled", "Repository map was cancelled");
  }
}

export class ContextLimitError extends ContextError {
  constructor(message = "Repository map time limit exceeded") {
    super("ContextLimitError", "limit_exceeded", message);
  }
}

export class ContextClosedError extends ContextError {
  constructor() {
    super("ContextClosedError", "closed", "Repository map provider is closed");
  }
}

export class ContextIoError extends ContextError {
  constructor() {
    super("ContextIoError", "io", "Repository read failed");
  }
}
