#!/usr/bin/env bash

# Some environments ship a `bash` that does not support `set -o pipefail`.
# Use it when available, but don't fail hard when it's not.
set -e
set -u
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/server/.env"
ENV_EXAMPLE="$ROOT_DIR/server/.env.example"

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

  printf '127.0.0.1\n'
}

set_env_value() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

set_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    COMPOSE_DISPLAY='docker compose'
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
    COMPOSE_DISPLAY='docker-compose'
    return
  fi

  printf 'Docker Compose was not found. Install Docker Compose and run this script again.\n' >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker was not found. Install Docker and run this script again.\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf 'Docker is not running or is not accessible by this user.\n' >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    printf 'Missing %s and %s.\n' "$ENV_FILE" "$ENV_EXAMPLE" >&2
    exit 1
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
fi

SYSTEM_IP="$(detect_ip)"
APP_URL="https://${SYSTEM_IP}"

set_env_value "APP_HOST" "$SYSTEM_IP"
set_env_value "APP_URL" "$APP_URL"
set_env_value "PUBLIC_APP_URL" "$APP_URL"
set_env_value "LM_STUDIO_URL" "http://${SYSTEM_IP}:1234"

COMPOSE=()
COMPOSE_DISPLAY=''
set_compose_cmd

printf 'Detected system IP: %s\n' "$SYSTEM_IP"
printf 'Starting EvigStudio services...\n'

(cd "$ROOT_DIR" && "${COMPOSE[@]}" up -d --build)

printf '\nEvigStudio services are starting.\n'
printf 'Frontend: %s\n' "$APP_URL"
printf 'API health: %s/api/health\n' "$APP_URL"
printf 'PostgreSQL: %s\n' '127.0.0.1:5434'
printf '\nUse "%s logs -f" from %s to follow service logs.\n' "$COMPOSE_DISPLAY" "$ROOT_DIR"
