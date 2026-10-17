#!/usr/bin/env bash
# Enable LiveChopper's in-repo git hooks (pre-commit runs ./scripts/test.sh;
# see scripts/hooks/pre-commit). Same approach as Schwung's.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

chmod +x scripts/hooks/pre-commit
git config core.hooksPath scripts/hooks

echo "Enabled: core.hooksPath = scripts/hooks"
echo "Pre-commit now runs: ./scripts/test.sh (DSP + UI tests)."
echo "Bypass a commit with:  git commit --no-verify"
