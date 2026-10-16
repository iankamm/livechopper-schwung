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

echo "=== UI ==="
node tests/ui_smoke.mjs | tail -1
