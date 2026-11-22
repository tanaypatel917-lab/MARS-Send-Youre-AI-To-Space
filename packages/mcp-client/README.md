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

The host account needs a private, writable home on an executable filesystem,
outside agent-writable roots. Launches use a unique directory there (on Windows,
its protection depends on the host profile ACL). This binds the reviewed files;
it does not sandbox the child, pin transitive imports, shebang interpreters or
dynamic libraries, or defend against another process controlling the host account.
