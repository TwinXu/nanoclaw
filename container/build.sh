#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Detect container runtime
if [ -n "$CONTAINER_RUNTIME" ]; then
  case "$CONTAINER_RUNTIME" in
    apple-container) RUNTIME_BIN="container" ;;
    docker)          RUNTIME_BIN="docker" ;;
    *)
      echo "Error: Invalid CONTAINER_RUNTIME='$CONTAINER_RUNTIME'. Must be 'apple-container' or 'docker'."
      exit 1
      ;;
  esac
elif command -v container &>/dev/null; then
  RUNTIME_BIN="container"
elif command -v docker &>/dev/null; then
  RUNTIME_BIN="docker"
else
  echo "Error: No container runtime found. Install Apple Container or Docker."
  exit 1
fi

echo "Building NanoClaw agent container image..."
echo "Runtime: ${RUNTIME_BIN}"
echo "Image: ${IMAGE_NAME}:${TAG}"

${RUNTIME_BIN} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${RUNTIME_BIN} run -i ${IMAGE_NAME}:${TAG}"
