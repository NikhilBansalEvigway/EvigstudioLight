#!/usr/bin/env bash

set -e
set -u
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE_API="$ROOT_DIR/server/.env.offline"
ENV_EXAMPLE_API="$ROOT_DIR/server/.env.offline.example"

ENV_FILE_ORCH="$ROOT_DIR/LLMOrchestrator/.env.offline"
ENV_EXAMPLE_ORCH="$ROOT_DIR/LLMOrchestrator/.env.offline.example"

detect_ip() {
  if [[ -n "${APP_HOST:-}" ]]; then
    printf '%s\n' "$APP_HOST"
    return
  fi

  if command -v ip >/dev/null 2>&1; then
    local route_ip
    route_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)"
    if [[ -n "$route_ip" ]]; then
      printf '%s\n' "$route_ip"
      return
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    local host_ip
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    if [[ -n "$host_ip" ]]; then
      printf '%s\n' "$host_ip"
      return
    fi
  fi

  # Fallback for environments where we can't detect an interface IP.
  printf '10.20.20.25\n'
}

detect_lm_studio_base_url() {
  # Allow override for testing (e.g. LM Studio exposed via ngrok).
  if [[ -n "${LM_STUDIO_BASE_URL:-}" ]]; then
    printf '%s\n' "${LM_STUDIO_BASE_URL%/}"
    return
  fi
  if [[ -n "${LM_STUDIO_URL:-}" ]]; then
    printf '%s\n' "${LM_STUDIO_URL%/}"
    return
  fi

  # Default: assume LM Studio is reachable on the detected machine IP.
  printf 'http://%s:1234\n' "$SYSTEM_IP"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$file"
  fi
}

ensure_env_file() {
  local file="$1"
  local example="$2"

  if [[ -f "$file" ]]; then
    return
  fi
  if [[ -f "$example" ]]; then
    cp "$example" "$file"
  else
    printf 'Missing %s\n' "$example" >&2
    exit 1
  fi
}

ensure_env_file "$ENV_FILE_API" "$ENV_EXAMPLE_API"
ensure_env_file "$ENV_FILE_ORCH" "$ENV_EXAMPLE_ORCH"

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker was not found. Install Docker and run this script again.\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf 'Docker is not running or is not accessible by this user.\n' >&2
  exit 1
fi

COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    printf 'Docker Compose was not found. Install Docker Compose and run this script again.\n' >&2
    exit 1
  fi
fi

SYSTEM_IP="$(detect_ip)"
APP_URL="http://${SYSTEM_IP}"

# Keep API URLs consistent for offline LAN access
set_env_value "$ENV_FILE_API" "APP_HOST" "$SYSTEM_IP"
set_env_value "$ENV_FILE_API" "APP_URL" "$APP_URL"
set_env_value "$ENV_FILE_API" "PUBLIC_APP_URL" "$APP_URL"

# Route API -> Orchestrator (in the same compose network)
set_env_value "$ENV_FILE_API" "LLM_PROVIDER" "orchestrator"
set_env_value "$ENV_FILE_API" "LLM_ORCHESTRATOR_URL" "http://llm-orch:3013"

LM_BASE_URL="$(detect_lm_studio_base_url)"

# Route Orchestrator -> LM Studio
set_env_value "$ENV_FILE_ORCH" "LM_STUDIO_BASE_URL" "$LM_BASE_URL"

PROJECT_APP="evigstudiolight"
PROJECT_ORCH_LEGACY="evig-studio"

ORCH_VOLUME_NAME="evig-studio_llm-db-data"

printf 'Detected system IP: %s\n' "$SYSTEM_IP"
printf 'LM Studio upstream: %s\n' "$LM_BASE_URL"

# Ensure the orchestrator DB volume exists (compose marks it external so we can
# reuse an existing volume created by a legacy project name).
if ! docker volume inspect "$ORCH_VOLUME_NAME" >/dev/null 2>&1; then
  docker volume create "$ORCH_VOLUME_NAME" >/dev/null
fi

# Stop existing stacks cleanly (keep volumes/data)
(
  cd "$ROOT_DIR"
  "${COMPOSE[@]}" -p "$PROJECT_APP" -f docker-compose.yml -f docker-compose.offline.yml down --remove-orphans >/dev/null 2>&1 || true
  "${COMPOSE[@]}" -p "$PROJECT_APP" -f docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
  # If an older orchestrator stack is running under its own project, stop it too.
  "${COMPOSE[@]}" -p "$PROJECT_ORCH_LEGACY" -f LLMOrchestrator/docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
)

printf 'Starting EvigStudio (offline profile)...\n'
(
  cd "$ROOT_DIR"
  # Prefer prebuilt images for fully-offline deployments.
  if ! "${COMPOSE[@]}" -p "$PROJECT_APP" -f docker-compose.yml -f docker-compose.offline.yml up -d --no-build; then
    "${COMPOSE[@]}" -p "$PROJECT_APP" -f docker-compose.yml -f docker-compose.offline.yml up -d --build
  fi
)

# Best-effort: force all orchestrator model backends to the detected LM Studio URL.
# This keeps routing correct even if the orchestrator DB was previously configured
# for a different machine/IP.
ORCH_CONTAINER="${PROJECT_APP}-llm-orch-1"
if docker inspect "$ORCH_CONTAINER" >/dev/null 2>&1; then
  docker exec -i "$ORCH_CONTAINER" python - <<'PY' || true
import json
import os
import sqlite3

db_path = "/data/llm_orchestrator.db"
base = (os.environ.get("LM_STUDIO_BASE_URL") or "").strip().rstrip("/")
if not base:
    raise SystemExit(0)

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Update runtime-config entry (JSON string) used by model discovery.
cur.execute(
    "UPDATE config_entries SET value_json = ?, updated_by = ? WHERE key = 'lm_studio_base_url'",
    (json.dumps(base), "offline_bootstrap"),
)

# Update all enabled models to route to this LM Studio.
cur.execute(
    "UPDATE model_configs SET backend_url = ? WHERE is_enabled = 1",
    (base,),
)

conn.commit()
print(f"[offline] orchestrator backend_url set to {base}")
PY
fi

printf '\nEvigStudio is starting.\n'
printf 'Open: %s\n' "$APP_URL"
