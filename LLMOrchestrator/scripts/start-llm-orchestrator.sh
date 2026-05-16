#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NETWORK_NAME="agent-net"
LLM_DIR="$ROOT_DIR/LLMOrchestrator"
LLM_ENV_FILE="$LLM_DIR/.env"
LLM_COMPOSE_FILE="$LLM_DIR/docker-compose.yml"

LLM_WORKER_REPLICAS="${LLM_WORKER_REPLICAS:-1}"
BUILD_IMAGES="${BUILD_IMAGES:-0}"
BUILD_RETRY_COUNT="${BUILD_RETRY_COUNT:-3}"

usage() {
  cat <<'EOF'
Usage: ./scripts/start-llm-orchestrator.sh [command]

Commands:
  start       Start LLMOrchestrator + worker + redis (default)
  stop        Stop the stack
  restart     Restart the stack
  logs        Follow logs for all services
  status      Show service status

Environment options:
  LLM_WORKER_REPLICAS   Number of llm orchestrator workers (default: 1)
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

# Auth for /admin and /admin-ui
ADMIN_JWT_SECRET=change-me
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123

# LM Studio on the host machine (reachable from the container)
LM_STUDIO_BASE_URL=http://host.docker.internal:1234

ENABLE_STREAMING=true
EOF
}

start_stack() {
  local up_args
  local attempt

  require_docker
  ensure_network
  ensure_llm_env

  echo "Starting LLMOrchestrator stack..."
  up_args=(-f "$LLM_COMPOSE_FILE" up -d --scale "llm-orchestrator-worker=${LLM_WORKER_REPLICAS}")

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
  echo "LLMOrchestrator is starting:"
  echo "  API:       http://127.0.0.1:3013"
  echo "  Admin UI:  http://127.0.0.1:3013/admin-ui"
  echo "  Workers:   $LLM_WORKER_REPLICAS"
  echo ""
  echo "Run './scripts/start-llm-orchestrator.sh logs' to follow startup logs."
}

stop_stack() {
  require_docker
  compose -f "$LLM_COMPOSE_FILE" down
}

status_stack() {
  require_docker
  compose -f "$LLM_COMPOSE_FILE" ps
}

logs_stack() {
  require_docker
  compose -f "$LLM_COMPOSE_FILE" logs -f
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
