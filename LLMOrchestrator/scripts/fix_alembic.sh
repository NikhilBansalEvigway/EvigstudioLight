#!/bin/bash
# Fix alembic version from 008 to 007

DB_PATH="$HOME/.evigstudio/openhands.db"

echo "🔍 Database path: $DB_PATH"

if [ ! -f "$DB_PATH" ]; then
    echo "❌ Database file not found!"
    exit 1
fi

# Check current version
CURRENT_VERSION=$(sqlite3 "$DB_PATH" "SELECT version_num FROM alembic_version;" 2>/dev/null)

if [ -z "$CURRENT_VERSION" ]; then
    echo "⚠️  No version found in alembic_version table"
    echo "🔧 Inserting version '007'..."
    sqlite3 "$DB_PATH" "INSERT INTO alembic_version (version_num) VALUES ('007');"
    echo "✅ Successfully set alembic version to '007'"
else
    echo "📊 Current alembic version: $CURRENT_VERSION"

    if [ "$CURRENT_VERSION" = "008" ]; then
        echo "🔧 Fixing version from '008' to '007'..."
        sqlite3 "$DB_PATH" "UPDATE alembic_version SET version_num = '007';"
        echo "✅ Successfully updated alembic version to '007'"
    else
        echo "ℹ️  Version is already '$CURRENT_VERSION', no fix needed"
    fi
fi

echo ""
echo "✅ Done! You can now start the server."
