#!/bin/bash

# Test PostgreSQL Migration Script
# This script tests the complete PostgreSQL setup

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     PostgreSQL Migration Test Script                          ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Check Docker
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 1: Checking Docker..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install Docker first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker is installed${NC}"
echo ""

# Step 2: Start PostgreSQL
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 2: Starting PostgreSQL..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

docker-compose -f docker-compose.db.yml up -d

echo -e "${GREEN}✓ PostgreSQL container started${NC}"
echo ""

# Step 3: Wait for PostgreSQL to be ready
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 3: Waiting for PostgreSQL to be ready..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

sleep 5

MAX_RETRIES=30
RETRY_COUNT=0

until docker exec postgres16 pg_isready -U postgres -d evigstudio > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo -e "${RED}❌ PostgreSQL failed to start after ${MAX_RETRIES} attempts${NC}"
        exit 1
    fi
    echo "   Waiting... (${RETRY_COUNT}/${MAX_RETRIES})"
    sleep 2
done

echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
echo ""

# Step 4: Set environment variables
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 4: Setting environment variables..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

export DB_HOST=postgres16
export DB_PORT=5432
export DB_NAME=evigstudio
export DB_USER=postgres
export DB_PASS=admin

echo -e "${GREEN}✓ Environment variables set:${NC}"
echo "   DB_HOST=$DB_HOST"
echo "   DB_PORT=$DB_PORT"
echo "   DB_NAME=$DB_NAME"
echo "   DB_USER=$DB_USER"
echo""

# Step 5: Test database connection
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 5: Testing database connection..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if docker exec postgres16 psql -U postgres -d evigstudio -c "SELECT 1;" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Database connection successful${NC}"
else
    echo -e "${RED}❌ Database connection failed${NC}"
    exit 1
fi
echo ""

# Step 6: Check if application can start
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 6: Testing application startup..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo -e "${YELLOW}Starting application (this may take a moment)...${NC}"
echo ""

# Start application in background
poetry run uvicorn openhands.server.listen:app --host 127.0.0.1 --port 3000 > /tmp/app_startup.log 2>&1 &
APP_PID=$!

# Wait for application to start
sleep 10

# Check if application is still running
if ps -p $APP_PID > /dev/null; then
    echo -e "${GREEN}✓ Application started successfully${NC}"

    # Kill the application
    kill $APP_PID 2>/dev/null || true
    wait $APP_PID 2>/dev/null || true
else
    echo -e "${RED}❌ Application failed to start${NC}"
    echo ""
    echo "Startup logs:"
    cat /tmp/app_startup.log
    exit 1
fi

 created:"
    docker exec postgres16 psql -U postgres -d evigstudio -c "\dt" | grep public
else
    echo -e "${RED}❌ Expected at least 10 tables, found $TABLES${NC}"
    exit 1
fi
echo ""

# Step 8: Verify roles
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 8: Verifying default roles..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ROLES=$(docker exec postgres16 psql -U postgres -d evigstudio -t -c "SELECT COUNT(*) FROM roles;")
ROLES=$(echo $ROLES | tr -d ' ')

if [ "$ROLES" -ge "5" ]; then
    echo -e "${GREEN}✓ Found $ROLES roles${NC}"

    echo ""
    echo "Default roles:"
    docker exec postgres16 psql -U postgres -d evigstudio -c "SELECT id, name, rank FROM roles ORDER BY rank;"
else
    echo -e "${RED}❌ Expected at least 5 roles, found $ROLES${NC}"
    exit 1
fi
echo ""

# Step 9: Verify permissions
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 9: Verifying permissions..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

PERMS=$(docker exec postgres16 psql -U postgres -d evigstudio -t -c "SELECT COUNT(*) FROM permissions;")
PERMS=$(echo $PERMS | tr -d ' ')

if [ "$PERMS" -ge "14" ]; then
    echo -e "${GREEN}✓ Found $PERMS permissions${NC}"
else
    echo -e "${RED}❌ Expected at least 14 permissions, found $PERMS${NC}"
    exit 1
fi
echo ""

# Success!
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    ✅ ALL TESTS PASSED! ✅                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Your PostgreSQL setup is working correctly!"
echo ""
echo "To start the application with PostgreSQL:"
echo ""
echo "  export DB_HOST=localhost"
echo "  export DB_PORT=5432"
echo "  export DB_NAME=evigstudio"
echo "  export DB_USER=postgres"
echo "  export DB_PASS=admin"
echo ""
echo "  poetry run uvicorn openhands.server.listen:app --host 127.0.0.1 --port 3000"
echo ""
echo "To stop PostgreSQL:"
echo ""
echo "  docker-compose -f docker-compose.db.yml down"
echo ""
