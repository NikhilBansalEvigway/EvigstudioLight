#!/usr/bin/env bash
set -euo pipefail

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

retry() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  local attempt=1
  until "$@"; do
    local exit_code=$?
    if [[ "$attempt" -ge "$attempts" ]]; then
      return "$exit_code"
    fi
    printf 'Attempt %d/%d failed. Retrying in %ss...\n' "$attempt" "$attempts" "$delay_seconds" >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done
}

compose_up_build() {
  (cd "$ROOT_DIR" && "${COMPOSE[@]}" up -d --build)
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
set_env_value "LLM_ORCHESTRATOR_URL" "http://llm-orch:3013"

COMPOSE=()
COMPOSE_DISPLAY=''
set_compose_cmd

printf 'Detected system IP: %s\n' "$SYSTEM_IP"
printf 'Starting EvigStudio services...\n'

printf 'Pulling base images (with retries)...\n'
retry 3 5 docker pull node:20-alpine
retry 3 5 docker pull nginx:alpine
retry 3 5 docker pull postgres:16-alpine

printf 'Bringing up compose stack (with retries)...\n'
retry 3 8 compose_up_build

printf '\nEvigStudio services are starting.\n'
printf 'Frontend: %s\n' "$APP_URL"
printf 'API health: %s/api/health\n' "$APP_URL"
printf 'PostgreSQL: %s\n' '127.0.0.1:5434'
printf '\nUse "%s logs -f" from %s to follow service logs.\n' "$COMPOSE_DISPLAY" "$ROOT_DIR"
