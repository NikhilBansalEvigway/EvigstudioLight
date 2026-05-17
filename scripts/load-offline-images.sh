#!/usr/bin/env bash
set -euo pipefail

# Load offline Docker images, then (optionally) start the docker-images compose stack.
#
# Usage:
#   ./scripts/load-offline-images.sh
#   ./scripts/load-offline-images.sh --up

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG_DIR="$ROOT_DIR/docker-images"
COMPOSE_FILE="$IMG_DIR/docker-compose.yml"
TAR="$IMG_DIR/evigstudio-offline-images.tar"

UP=0
if [[ "${1:-}" == "--up" ]]; then
  UP=1
fi

if [[ -f "$TAR" ]]; then
  echo "Loading bundle tar: $TAR"
  docker load -i "$TAR"
else
  echo "Bundle tar not found ($TAR). Loading all per-image tarballs in $IMG_DIR ..."
  shopt -s nullglob
  found=0
  for f in "$IMG_DIR"/*.tar; do
    found=1
    echo "  - docker load -i $(basename "$f")"
    docker load -i "$f" >/dev/null
  done
  shopt -u nullglob
  if [[ $found -eq 0 ]]; then
    echo "No tarballs found in $IMG_DIR" >&2
    exit 1
  fi
fi

if [[ $UP -eq 1 ]]; then
  echo "Starting compose stack: $COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" up -d
fi
