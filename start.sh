#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
ENV_FILE="$ROOT_DIR/server/.env"
ENV_EXAMPLE="$ROOT_DIR/server/.env.example"

detect_ip() {
  local ip_address=""

  if command -v ip >/dev/null 2>&1; then
    ip_address="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  fi

  if [ -z "$ip_address" ] && command -v hostname >/dev/null 2>&1; then
    ip_address="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  if [ -z "$ip_address" ]; then
    ip_address="127.0.0.1"
  fi

  printf '%s' "$ip_address"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp_file=""
  local found="0"

  tmp_file="$(mktemp)"

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key"=*)
        printf '%s=%s\n' "$key" "$value" >>"$tmp_file"
        found="1"
        ;;
      *)
        printf '%s\n' "$line" >>"$tmp_file"
        ;;
    esac
  done <"$ENV_FILE"

  if [ "$found" = "0" ]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp_file"
  fi

  mv "$tmp_file" "$ENV_FILE"
}

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker is required but was not found in PATH.\n' >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  printf 'Docker Compose is required but was not found.\n' >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  printf 'Missing docker-compose.yml at %s\n' "$COMPOSE_FILE" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ ! -f "$ENV_EXAMPLE" ]; then
    printf 'Missing server/.env and server/.env.example.\n' >&2
    exit 1
  fi

  cp "$ENV_EXAMPLE" "$ENV_FILE"
  printf 'Created server/.env from server/.env.example. Review secrets before production use.\n'
fi

SYSTEM_IP="$(detect_ip)"

set_env_value "APP_HOST" "$SYSTEM_IP"
set_env_value "APP_URL" "https://$SYSTEM_IP"
set_env_value "PUBLIC_APP_URL" "https://$SYSTEM_IP"
set_env_value "LM_STUDIO_URL" "http://$SYSTEM_IP:1234"

printf 'Detected system IP: %s\n' "$SYSTEM_IP"
printf 'Updated server/.env with LAN startup values.\n'
printf 'Starting EvigStudio and sub-services...\n'
"${COMPOSE[@]}" -f "$COMPOSE_FILE" up --build -d

printf '\nServices:\n'
"${COMPOSE[@]}" -f "$COMPOSE_FILE" ps

printf '\nEvigStudio is starting at:\n'
printf '  http://localhost\n'
printf '  https://localhost\n'
printf '  http://%s\n' "$SYSTEM_IP"
printf '  https://%s\n' "$SYSTEM_IP"
printf '\nView logs with: %s -f %s logs -f\n' "${COMPOSE[*]}" "$COMPOSE_FILE"
printf 'Stop services with: %s -f %s down\n' "${COMPOSE[*]}" "$COMPOSE_FILE"
