#!/usr/bin/env python3
"""Reset migration state using SQLAlchemy"""
from sqlalchemy import create_engine, text

# Database URL
db_url = "postgresql+pg8000://postgres:admin@localhost:5432/evigstudio"

print(f"Connecting to database...")

try:
    engine = create_engine(db_url)

    with engine.connect() as conn:
        # Check current version
        result = conn.execute(text("SELECT version_num FROM alembic_version"))
        current_version = result.fetchone()

        if current_version:
            print(f"Current version: {current_version[0]}")

            if current_version[0] == '101':
                print("Rolling back to version 100...")
                conn.execute(text("UPDATE alembic_version SET version_num = '100'"))
                conn.commit()
                print("✓ Rolled back to 100")
            elif current_version[0] == '100':
                print("✓ Already at version 100")
        else:
            print("No version found in alembic_version table")

    print("✅ Done! Restart the app to run migration 101.")

except Exception as e:
    print(f"❌ Error: {e}")
    import traceback
    traceback.print_exc()
    exit(1)
