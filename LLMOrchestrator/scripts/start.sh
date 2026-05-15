#!/bin/bash

# ─── Config ────────────────────────────────────────────────────────────────────
export PGPASSWORD=admin
DB_HOST=localhost
DB_PORT=5432
DB_NAME=evigstudio
DB_USER=postgres
ALEMBIC_DIR=/mnt/c/Users/rishi/Documents/Evigway/Evig-Studio/openhands/app_server/app_lifespan
PROJECT_DIR=/mnt/c/Users/rishi/Documents/Evigway/Evig-Studio

psql_cmd="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c"

# ─── Helpers ───────────────────────────────────────────────────────────────────
col_exists() {
    $psql_cmd "SELECT COUNT(*) FROM information_schema.columns
               WHERE table_name='$1' AND column_name='$2';" | tr -d ' \n'
}

table_exists() {
    $psql_cmd "SELECT COUNT(*) FROM information_schema.tables
               WHERE table_name='$1';" | tr -d ' \n'
}

index_exists() {
    $psql_cmd "SELECT COUNT(*) FROM pg_indexes
               WHERE tablename='$1' AND indexname='$2';" | tr -d ' \n'
}

enum_exists() {
    $psql_cmd "SELECT COUNT(*) FROM pg_type WHERE typname='$1';" | tr -d ' \n'
}

col_type() {
    $psql_cmd "SELECT udt_name FROM information_schema.columns
               WHERE table_name='$1' AND column_name='$2';" | tr -d ' \n'
}

get_version() {
    $psql_cmd "SELECT version_num FROM alembic_version;" | tr -d ' \n'
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Current alembic version: $(get_version)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Cleanup: finish what 097 left half-done ───────────────────────────────────
echo "🔧 Checking for leftover state from partial 097..."

if [ "$(table_exists conversation_permissions)" = "1" ]; then
    echo "  ↳ Dropping leftover conversation_permissions table..."
    $psql_cmd "
        DROP INDEX IF EXISTS ix_conversation_permissions_conversation_id;
        DROP INDEX IF EXISTS ix_conversation_permissions_group_id;
        DROP TABLE conversation_permissions;
    " > /dev/null
    echo "  ✅ conversation_permissions dropped"
else
    echo "  ⏭  conversation_permissions already gone"
fi

if [ "$(col_exists conversation_metadata visibility)" = "1" ]; then
    echo "  ↳ Dropping leftover visibility column..."
    $psql_cmd "
        DROP INDEX IF EXISTS ix_conversation_metadata_visibility;
        ALTER TABLE conversation_metadata DROP COLUMN visibility;
    " > /dev/null
    echo "  ✅ visibility dropped"
else
    echo "  ⏭  visibility already gone"
fi

if [ "$(col_exists conversation_metadata user_id)" = "1" ]; then
    echo "  ↳ Dropping leftover user_id column..."
    $psql_cmd "ALTER TABLE conversation_metadata DROP COLUMN user_id;" > /dev/null
    echo "  ✅ user_id dropped"
else
    echo "  ⏭  user_id already gone"
fi

if [ "$(index_exists event_callback ix_event_callback_updated_at)" = "0" ]; then
    echo "  ↳ Creating missing ix_event_callback_updated_at index..."
    $psql_cmd "CREATE INDEX IF NOT EXISTS ix_event_callback_updated_at
               ON event_callback (updated_at);" > /dev/null
    echo "  ✅ Index created"
else
    echo "  ⏭  ix_event_callback_updated_at already exists"
fi

# ─── Cleanup: fix enum types (098) ────────────────────────────────────────────
echo "🔧 Checking for leftover enum types..."

if [ "$(col_type app_conversation_start_task status)" != "varchar" ]; then
    echo "  ↳ Fixing app_conversation_start_task.status enum → varchar..."
    $psql_cmd "ALTER TABLE app_conversation_start_task
               ALTER COLUMN status TYPE VARCHAR USING status::VARCHAR;" > /dev/null
    echo "  ✅ Fixed"
else
    echo "  ⏭  app_conversation_start_task.status already varchar"
fi

if [ "$(col_type event_callback_result status)" != "varchar" ]; then
    echo "  ↳ Fixing event_callback_result.status enum → varchar..."
    $psql_cmd "ALTER TABLE event_callback_result
               ALTER COLUMN status TYPE VARCHAR USING status::VARCHAR;" > /dev/null
    echo "  ✅ Fixed"
else
    echo "  ⏭  event_callback_result.status already varchar"
fi

if [ "$(enum_exists appconversationstarttaskstatus)" = "1" ]; then
    $psql_cmd "DROP TYPE IF EXISTS appconversationstarttaskstatus;" > /dev/null
    echo "  ✅ Dropped appconversationstarttaskstatus type"
fi

if [ "$(enum_exists eventcallbackresultstatus)" = "1" ]; then
    $psql_cmd "DROP TYPE IF EXISTS eventcallbackresultstatus;" > /dev/null
    echo "  ✅ Dropped eventcallbackresultstatus type"
fi

echo "✅ Cleanup done"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Stamp to correct version then upgrade ────────────────────────────────────
echo "🔖 Syncing alembic version..."
cd $ALEMBIC_DIR

CURRENT=$(get_version)
echo "  Current: $CURRENT"

if [ "$CURRENT" = "097" ]; then
    echo "  ↳ Stamping 098 (already applied manually)..."
    cd $PROJECT_DIR && poetry run alembic -c $ALEMBIC_DIR/alembic.ini stamp 098
    cd $ALEMBIC_DIR
fi

echo "⬆️  Running alembic upgrade head..."
cd $PROJECT_DIR && poetry run alembic -c $ALEMBIC_DIR/alembic.ini upgrade head

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Final version: $(get_version)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Start Server ──────────────────────────────────────────────────────────────
echo "🚀 Starting server..."
cd $PROJECT_DIR
export DB_HOST=localhost DB_PORT=5432 DB_NAME=evigstudio DB_USER=postgres DB_PASS=admin
poetry run uvicorn openhands.server.v1_listen:app --host 127.0.0.1 --port 3000
