#!/usr/bin/env bash
# The Python environment for step 4's analysis (docs/PLAN.md): numpy,
# scipy and matplotlib in build/.venv, which git ignores. Run the analysis
# scripts with build/.venv/bin/python.
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
if ! command -v uv >/dev/null 2>&1; then
    echo "Needs uv (https://docs.astral.sh/uv/): curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    exit 1
fi
[ -x build/.venv/bin/python ] || uv venv build/.venv
uv pip install --python build/.venv -r scripts/requirements-analysis.txt
