#!/bin/bash

# Improved startup script that works with both SQLite and PostgreSQL
# Automatically detects if PostgreSQL is available

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║              Evig Studio Startup Script                       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─── Check if .env file exists ────────────────────────────────────────────────
if [ -f ".env" ]; then
    echo -e "${BLUE}📄 Found .env file, loading environment variables...${NC}"
    export $(cat .env | grep -v '^#' | xargs)
    echo -e "${GREEN}✓ Environment variables loaded${NC}"
else
    echo -e "${YELLOW}⚠ No .env file found, using defaults${NC}"
fi

# ─── Detect database mode ─────────────────────────────────────────────────────
if [ -n "$DB_HOST" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}🐘 PostgreSQL Mode Detected${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Host: $DB_HOST"
    echo "  Port: ${DB_PORT:-5432}"

    if command -v psql &>/dev/null; then
        if psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -d "${DB_NAME:-evigstudio}" -c '\q' 2>/dev/null; then
            CURRENT_VERSION=$(psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -d "${DB_NAME:-evigstudio}" -t -c "SELECT version_num FROM alembic_version;" 2>/dev/null | tr -d ' \n' || echo "none")

            if [ "$CURRENT_VERSION" != "none" ]; then
                echo -e "${BLUE}📊 Current migration version: ${CURRENT_VERSION}${NC}"
            else
                echo -e "${YELLOW}⚠ No migration version found (fresh database)${NC}"
            fi
        else
            echo -e "${YELLOW}⚠ Cannot connect to PostgreSQL${NC}"
            echo -e "${YELLOW}  Make sure PostgreSQL is running:${NC}"
            echo -e "${YELLOW}  docker-compose -f docker-compose.db.yml up -d${NC}"
            echo ""
            echo -e "${YELLOW}Falling back to SQLite mode...${NC}"
            unset DB_HOST
        fi
    else
        echo -e "${YELLOW}⚠ psql command not found${NC}"
        echo -e "${YELLOW}  Install PostgreSQL client or use Docker${NC}"
        echo ""
        echo -e "${YELLOW}Falling back to SQLite mode...${NC}"
        unset DB_HOST
    fi
fi

if [ -z "$DB_HOST" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}💾 SQLite Mode${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Conversation DB: ~/.evigstudio/openhands.db"
    echo "  Admin DB: ~/.openhands/evig_studio.db"
    echo ""
    echo -e "${YELLOW}💡 Tip: For multi-user support, use PostgreSQL${NC}"
    echo -e "${YELLOW}   See QUICKSTART_POSTGRESQL.md for setup${NC}"
fi

# ─── Run migrations ───────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🔄 Running database migrations...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo -e "${GREEN}✓ Migrations will run automatically on startup${NC}"

# ─── Start server ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🚀 Starting Evig Studio...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
poetry run uvicorn openhands.server.v1_listen:app --host 127.0.0.1 --port 3000
