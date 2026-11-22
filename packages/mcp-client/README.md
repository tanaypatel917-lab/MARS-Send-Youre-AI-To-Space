# Stdio launch integrity

The trusted MCP loader and evidence probe hash private copies of the resolved
executable and every argument naming a regular file, then launch those copies.
Evidence still identifies the configured paths, not temporary names. A running
connection retains its copies until close. Reconnecting takes a fresh snapshot.

Use a standalone executable or a bundled script passed directly as a file
argument. A declared entrypoint must be the command or a file argument. File
arguments are read-only inputs, not output paths. The working directory and
non-file arguments stay unchanged; executable-relative libraries, sibling
imports, and writes through file arguments may no longer work. Bundle required
code rather than relying on the original file layout.

The file-backed host allocates a unique launch directory in its private registry
outside agent-writable roots. Custom registries can supply their own allocator;
otherwise the host account's home must also be outside those roots. Launch
storage needs an executable filesystem and host-only permissions (ACLs on
Windows). This binds the reviewed files;
it does not sandbox the child, pin transitive imports, shebang interpreters or
dynamic libraries, or defend against another process controlling the host account.
