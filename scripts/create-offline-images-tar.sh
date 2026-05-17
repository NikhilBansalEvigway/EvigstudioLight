#!/usr/bin/env bash
set -euo pipefail

# Create a single Docker image bundle tar for offline installs.
#
# Output:
#   docker-images/evigstudio-offline-images.tar
#
# Notes:
# - This script loads any existing per-image tarballs in docker-images/ first (if present).
# - Then it "docker save"s the images referenced by docker-images/docker-compose.yml
#   into one bundle tar.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG_DIR="$ROOT_DIR/docker-images"
COMPOSE_FILE="$IMG_DIR/docker-compose.yml"
OUT_TAR="$IMG_DIR/evigstudio-offline-images.tar"
BUILD_COMPOSE_FILE="$ROOT_DIR/docker-compose.offline.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing compose file: $COMPOSE_FILE" >&2
  exit 1
fi

mkdir -p "$IMG_DIR"

echo "[1/3] Loading any existing docker-images/*.tar (if any)..."
shopt -s nullglob
for f in "$IMG_DIR"/*.tar; do
  # Avoid re-loading the output tar if re-running.
  if [[ "$(basename "$f")" == "$(basename "$OUT_TAR")" ]]; then
    continue
  fi
  echo "  - docker load -i $(basename "$f")"
  docker load -i "$f" >/dev/null
done
shopt -u nullglob

echo "[2/3] Collecting image names from docker-images/docker-compose.yml..."

# Extract image names from the compose file.
# This intentionally ignores build-only services.
mapfile -t images < <(
  awk '
    $1 == "image:" { print $2 }
  ' "$COMPOSE_FILE" | sed 's/["\x27]//g' | awk 'NF' | sort -u
)

if [[ ${#images[@]} -eq 0 ]]; then
  echo "No images found in $COMPOSE_FILE" >&2
  exit 1
fi

echo "Images:";
for img in "${images[@]}"; do
  echo "  - $img"
done

missing=0
for img in "${images[@]}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    missing=1
  fi
done

if [[ $missing -eq 1 ]]; then
  echo "Some images are missing locally." >&2
  if [[ -f "$BUILD_COMPOSE_FILE" ]]; then
    echo "Attempting to build missing images using: $BUILD_COMPOSE_FILE" >&2
    echo "(If you are fully offline and base images are missing, this may fail.)" >&2
    # Best-effort pull for base images; ignore failures when offline.
    docker pull postgres:16-alpine >/dev/null 2>&1 || true
    docker pull redis:7-alpine >/dev/null 2>&1 || true
    docker compose -f "$BUILD_COMPOSE_FILE" build
  else
    echo "Build compose file not found: $BUILD_COMPOSE_FILE" >&2
    echo "Either load the images first (docker load -i <tar>) or run ./scripts/export-images.sh" >&2
    exit 1
  fi
fi

echo "[3/3] Saving single bundle tar -> $OUT_TAR"
docker save -o "$OUT_TAR" "${images[@]}"

echo "Bundle created: $OUT_TAR"
