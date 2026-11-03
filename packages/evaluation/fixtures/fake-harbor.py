#!/usr/bin/env python3
"""Stand-in for `harbor run` used by offline tests. Never touches Docker.

Modes (env FAKE_HARBOR_MODE):
  copy   - copies the fixture job dir named by FAKE_HARBOR_FIXTURE into `-o/--job-name` and exits 0
  hang   - spawns a grandchild `sleep` and waits forever (deadline/cancel kill test)
  exit0-error - like copy but exits 0 while the fixture contains errored trials (default)
"""
import os, shutil, signal, subprocess, sys, time

args = sys.argv[1:]
out = args[args.index("-o") + 1]
name = args[args.index("--job-name") + 1]
mode = os.environ.get("FAKE_HARBOR_MODE", "copy")
marker = os.environ.get("FAKE_HARBOR_MARKER")
if marker:
    with open(marker, "a", encoding="utf-8") as handle:
        handle.write(" ".join(args) + "\n")
if "--dry-run" in args:
    print("Dry run OK — 1 trial(s); nothing was run.")
    sys.exit(0)
if mode == "hang":
    child = subprocess.Popen(["sleep", "600"])
    pidfile = os.environ.get("FAKE_HARBOR_PIDFILE")
    if pidfile:
        with open(pidfile, "w", encoding="utf-8") as handle:
            handle.write(f"{os.getpid()} {child.pid}\n")
    signal.signal(signal.SIGTERM, signal.SIG_IGN)  # only a process-group kill reaches the grandchild
    while True:
        time.sleep(1)
fixture = os.environ["FAKE_HARBOR_FIXTURE"]
shutil.copytree(fixture, os.path.join(out, name))
print(f"Results written to {os.path.join(out, name, 'result.json')}")
sys.exit(0)
