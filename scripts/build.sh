#!/usr/bin/env bash
# Build LiveChopper module for Schwung (ARM64)
#
# Adapted from schwung-waveform-editor, Copyright (c) 2025 Charles Vestal (MIT).
#
# Automatically uses Docker for cross-compilation if needed.
# Set CROSS_PREFIX to skip Docker (e.g., for native ARM builds).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
MODULE_ID="live-chopper"
IMAGE_NAME="schwung-builder"

# Use a locally installed cross-compiler if there is one
if [ -z "$CROSS_PREFIX" ] && command -v aarch64-linux-gnu-gcc &>/dev/null; then
    CROSS_PREFIX="aarch64-linux-gnu-"
fi

# Check if we need Docker
if [ -z "$CROSS_PREFIX" ] && [ ! -f "/.dockerenv" ]; then
    echo "=== LiveChopper module Build (via Docker) ==="
    echo ""

    # Build Docker image if needed
    if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
        echo "Building Docker image (first time only)..."
        docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"
        echo ""
    fi

    # Run build inside container
    echo "Running build..."
    docker run --rm \
        -v "$REPO_ROOT:/build" \
        -u "$(id -u):$(id -g)" \
        -w /build \
        "$IMAGE_NAME" \
        ./scripts/build.sh

    echo ""
    echo "=== Done ==="
    exit 0
fi

# === Actual build (runs in Docker or with cross-compiler) ===
CROSS_PREFIX="${CROSS_PREFIX:-aarch64-linux-gnu-}"

cd "$REPO_ROOT"

echo "=== Building LiveChopper module ==="

# Compile DSP plugin
echo "Compiling DSP..."
mkdir -p build

${CROSS_PREFIX}gcc -O2 -shared -fPIC \
    -march=armv8-a -mtune=cortex-a72 \
    -fomit-frame-pointer -fno-stack-protector \
    -Wall -Wextra \
    -DNDEBUG \
    src/dsp/plugin.c \
    -o build/dsp.so \
    -Isrc/dsp \
    -lm -lpthread

# Create dist directory
rm -rf "dist/$MODULE_ID"
mkdir -p "dist/$MODULE_ID"

# Copy files to dist (use cat to avoid ExtFS deallocation issues with Docker)
echo "Packaging..."
cat src/module.json > "dist/$MODULE_ID/module.json"
cat src/ui.js > "dist/$MODULE_ID/ui.js"
cat src/drum_rack.mjs > "dist/$MODULE_ID/drum_rack.mjs"
cat build/dsp.so > "dist/$MODULE_ID/dsp.so"
[ -f src/help.json ] && cat src/help.json > "dist/$MODULE_ID/help.json"
chmod +x "dist/$MODULE_ID/dsp.so"

# Create tarball for release
cd dist
tar -czvf "$MODULE_ID-module.tar.gz" "$MODULE_ID/"
cd ..

echo ""
echo "=== Build Complete ==="
echo "Output: dist/$MODULE_ID/"
echo "Tarball: dist/$MODULE_ID-module.tar.gz"
echo ""
echo "To install on Move:"
echo "  ./scripts/install.sh"
