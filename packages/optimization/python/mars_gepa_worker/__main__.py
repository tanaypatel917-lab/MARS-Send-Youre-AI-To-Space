import sys

from .worker import run

if __name__ == "__main__":
    sys.exit(run(sys.stdin, sys.stdout, sys.stderr))
