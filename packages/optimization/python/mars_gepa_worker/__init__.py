"""MARS GEPA worker: runs gepa.optimize behind a newline-delimited JSON protocol.

The worker never runs models or benchmarks. Scoring and reflection are brokered
to the TypeScript host over stdin/stdout; the host enforces budgets and may
kill this process at any time.
"""

__version__ = "0.0.1"
