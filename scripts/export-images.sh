#!/usr/bin/env bash
set -euo pipefail

# Builds/pulls all images used by docker-compose.images.yml and exports them as tarballs.
#
# Usage:
#   ./scripts/export-images.sh
#
# Output:
#   docker-images/*.tar

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/docker-images"

mkdir -p "$OUT_DIR"

compose_file="$ROOT_DIR/docker-compose.offline.yml"

echo "[1/3] Building local images..."
docker compose -f "$compose_file" build

echo "[2/3] Pulling upstream base images..."
docker pull postgres:16-alpine
docker pull redis:7-alpine

echo "[3/3] Exporting images to $OUT_DIR ..."

save() {
  local image="$1"
  local out="$2"
  echo "  - docker save $image -> $out"
  docker save -o "$out" "$image"
}

save "evigstudiolight-frontend:latest" "$OUT_DIR/evigstudiolight-frontend_latest.tar"
save "evigstudiolight-api:latest" "$OUT_DIR/evigstudiolight-api_latest.tar"
save "evigstudiolight-llm-orch:latest" "$OUT_DIR/evigstudiolight-llm-orch_latest.tar"
save "evigstudiolight-llm-orch-worker:latest" "$OUT_DIR/evigstudiolight-llm-orch-worker_latest.tar"
save "postgres:16-alpine" "$OUT_DIR/postgres_16-alpine.tar"
save "redis:7-alpine" "$OUT_DIR/redis_7-alpine.tar"

echo "Export complete."
