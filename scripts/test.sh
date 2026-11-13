#!/usr/bin/env bash
# Host-side tests: the DSP (native gcc + sanitizers) and the UI (node).
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p build

echo "=== DSP ==="
gcc -std=c11 -g -fsanitize=address,undefined -Wall -Isrc/dsp \
    tests/dsp_test.c -o build/dsp_test -lm -lpthread
build/dsp_test

echo "=== Knobs ==="
node tests/knobs_test.mjs

echo "=== UI ==="
node tests/ui_smoke.mjs | tail -1

# Move references (docs/PLAN.md step 4, "When an effect is done"): plugin.c
# against Move's curves in tests/move_refs/. Needs the analysis venv.
echo "=== Move references ==="
if [ -x build/.venv/bin/python ]; then
    export PYTHONDONTWRITEBYTECODE=1
    build/.venv/bin/python tools/fxlab/make_test_wavs.py > /dev/null
    build/.venv/bin/python tests/fxlab_selftest.py
    build/.venv/bin/python tools/fxlab/fxlab.py refs-check
else
    echo "skipped: no analysis venv (tools/fxlab/setup_env.sh)"
fi
