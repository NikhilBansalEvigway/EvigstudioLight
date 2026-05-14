#!/usr/bin/env python3
"""Reset migration 101 state in the database"""
import psycopg2

# Database configuration
db_host = 'postgres16'
db_port = '5432'
db_name = 'evigstudio'
db_user = 'postgres'
db_pass = 'admin'

print(f"Connecting to PostgreSQL at {db_host}:{db_port}/{db_name}...")

try:
    conn = psycopg2.connect(
        host=db_host,
        port=db_port,
        database=db_name,
        user=db_user,
        password=db_pass
    )
    conn.autocommit = True
    cursor = conn.cursor()

    # Check current version
    cursor.execute("SELECT version_num FROM alembic_version;")
    current_version = cursor.fetchone()
    print(f"Current alembic version: {current_version[0] if current_version else 'None'}")

    if current_version and current_version[0] == '101':
        print("\n⚠️  Migration 101 is marked as applied but may have failed.")
        print("Rolling back to version 100...")

        cursor.execute("UPDATE alembic_version SET version_num = '100';")
        print("✓ Rolled back alembic_version to 100")

        # Check if any columns from migration 101 exist
        cursor.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'conversation_metadata'
            AND column_name IN ('project_id', 'privacy_level', 'shared_with_groups',
                               'version_number', 'is_archived', 'archived_at', 'tags')
            ORDER BY column_name;
        """)
        existing_columns = cursor.fetchall()

        if existing_columns:
            print(f"\n⚠️  Found {len(existing_columns)} columns from migration 101:")
            for col in existing_columns:
                print(f"   - {col[0]}")
            print("\nThese columns will be handled by the migration when you restart the app.")
        else:
            print("\n✓ No columns from migration 101 found (clean state)")

    elif current_version and current_version[0] == '100':
        print("\n✓ Already at version 100. Ready to run migration 101.")

    else:
        print(f"\n⚠️  Unexpected version: {current_version[0] if current_version else 'None'}")
        print("You may need to manually investigate the database state.")

    cursor.close()
    conn.close()

    print("\n✅ Database state reset successfully!")
    print("You can now restart the application to run migration 101.")

except Exception as e:
    print(f"\n❌ Error: {e}")
    exit(1)
