#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NETWORK_NAME="agent-net"
ROOT_ENV_FILE="$ROOT_DIR/.env"
LLM_ENV_FILE="$ROOT_DIR/LLMOrchestrator/.env"
LLM_WORKER_REPLICAS="${LLM_WORKER_REPLICAS:-3}"
BUILD_IMAGES="${BUILD_IMAGES:-0}"
BUILD_RETRY_COUNT="${BUILD_RETRY_COUNT:-3}"

usage() {
  cat <<'EOF'
Usage: ./start-evigstudio.sh [command]

Commands:
  start       Start the full EvigStudio stack (default)
  stop        Stop the stack
  restart     Restart the stack
  logs        Follow logs for all services
  status      Show service status

Services started by this script:
  - PostgreSQL
  - Redis
  - Ollama
  - LLM orchestrator API
  - LLM orchestrator worker (scaled via LLM_WORKER_REPLICAS, default 3)
  - EvigStudio backend and bundled frontend
  - nginx HTTP/HTTPS gateway

Environment options:
  LLM_WORKER_REPLICAS   Number of llm orchestrator workers (default: 3)
  BUILD_IMAGES          Set to 1 to force docker rebuild on start (default: 0)
  BUILD_RETRY_COUNT     Rebuild retry attempts when BUILD_IMAGES=1 (default: 3)
EOF
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "Error: docker compose is required but was not found." >&2
    exit 1
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker is required but was not found." >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker is not running or is not accessible by this user." >&2
    exit 1
  fi
}

ensure_network() {
  if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    echo "Creating Docker network: $NETWORK_NAME"
    docker network create "$NETWORK_NAME" >/dev/null
  fi
}

detect_host_ip() {
  local detected_ip=""

  if command -v ip >/dev/null 2>&1; then
    detected_ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[^ ]+' | head -n 1 || true)"
  fi

  if [ -z "$detected_ip" ] && command -v hostname >/dev/null 2>&1; then
    detected_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi

  if [ -z "$detected_ip" ]; then
    detected_ip="127.0.0.1"
  fi

  printf '%s\n' "$detected_ip"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local temp_file

  touch "$file"
  temp_file="$(mktemp)"

  if grep -q "^${key}=" "$file"; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$key"=*) printf '%s=%s\n' "$key" "$value" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$file" > "$temp_file"
  else
    cp "$file" "$temp_file"
    printf '%s=%s\n' "$key" "$value" >> "$temp_file"
  fi

  mv "$temp_file" "$file"
}

ensure_root_env() {
  local host_ip

  host_ip="$(detect_host_ip)"
  set_env_value "$ROOT_ENV_FILE" "PUBLIC_HOST_IP" "$host_ip"
  echo "Using host IP: $host_ip"
}

ensure_llm_env() {
  if [ -f "$LLM_ENV_FILE" ]; then
    return
  fi

  echo "Creating LLM orchestrator env file: $LLM_ENV_FILE"
  cat > "$LLM_ENV_FILE" <<'EOF'
APP_ENV=development
APP_HOST=0.0.0.0
APP_PORT=3013
LOG_LEVEL=INFO
ADMIN_JWT_SECRET=change-me
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
LM_STUDIO_BASE_URL=http://172.16.16.50:1234
ENABLE_STREAMING=true
EOF
}

ensure_workspace() {
  mkdir -p "$ROOT_DIR/workspace"
  mkdir -p "$HOME/.evigstudio"
}

start_stack() {
  local host_ip
  local up_args
  local attempt

  require_docker
  ensure_network
  ensure_root_env
  ensure_llm_env
  ensure_workspace

  host_ip="$(detect_host_ip)"

  echo "Starting EvigStudio stack..."
  up_args=(-f "$ROOT_DIR/docker-compose.yml" up -d --scale "llm-orchestrator-worker=${LLM_WORKER_REPLICAS}")
  if [ "$BUILD_IMAGES" = "1" ]; then
    up_args+=(--build)
    attempt=1
    until compose "${up_args[@]}"; do
      if [ "$attempt" -ge "$BUILD_RETRY_COUNT" ]; then
        echo "Error: docker build failed after $BUILD_RETRY_COUNT attempts." >&2
        return 1
      fi
      attempt=$((attempt + 1))
      echo "Build failed (likely transient network issue). Retrying in 5s... (attempt $attempt/$BUILD_RETRY_COUNT)"
      sleep 5
    done
  else
    compose "${up_args[@]}"
  fi

  echo ""
  echo "EvigStudio is starting. Useful URLs:"
  echo "  App HTTP:       http://127.0.0.1:3000"
  echo "  App HTTPS:      https://127.0.0.1:3443"
  echo "  App LAN HTTPS:  https://$host_ip:3443"
  echo "  LLM API:        http://127.0.0.1:3013"
  echo "  LLM LAN API:    http://$host_ip:3013"
  echo "  LLM Admin UI:   http://127.0.0.1:3013/admin-ui"
  echo "  Build Mode:     $( [ "$BUILD_IMAGES" = "1" ] && echo "rebuild" || echo "reuse existing images" )"
  echo "  LLM Workers:    $LLM_WORKER_REPLICAS"
  echo "  Ollama:         http://127.0.0.1:11434"
  echo ""
  echo "Run './start-evigstudio.sh logs' to follow startup logs."
}

stop_stack() {
  require_docker
  compose -f "$ROOT_DIR/docker-compose.yml" down
}

status_stack() {
  require_docker
  compose -f "$ROOT_DIR/docker-compose.yml" ps
}

logs_stack() {
  require_docker
  compose -f "$ROOT_DIR/docker-compose.yml" logs -f
}

command="${1:-start}"

case "$command" in
  start)
    start_stack
    ;;
  stop)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    ;;
  logs)
    logs_stack
    ;;
  status)
    status_stack
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $command" >&2
    usage
    exit 1
    ;;
esac
