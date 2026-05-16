#!/usr/bin/env python3
"""
Create a fresh database bypassing alembic migrations.
This creates the database schema directly from SQLAlchemy models.
"""

import os
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from openhands.app_server.utils.sql_utils import Base, get_db_session_injector
from openhands.app_server.config import get_global_config

def create_fresh_database():
    """Create database tables from SQLAlchemy models."""
    print("Creating fresh database...")
    print("-" * 50)

    # Get database path
    config = get_global_config()
    db_injector = get_db_session_injector(config)

    # Get the database URL
    db_url = db_injector.database_url
    print(f"Database URL: {db_url}")

    # Extract database file path
    if db_url.startswith("sqlite:///"):
        db_path = db_url.replace("sqlite:///", "")

        # Delete existing database
        if os.path.exists(db_path):
            os.remove(db_path)
            print(f"✓ Deleted existing database: {db_path}")

    # Create all tables from models
    engine = db_injector.engine
    Base.metadata.create_all(engine)
    print("✓ Created all database tables from models")

    # Create alembic_version table and set to latest migration
    from sqlalchemy import text
    with engine.connect() as conn:
        # Create alembic_version table
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS alembic_version (
                version_num VARCHAR(32) NOT NULL,
                CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
            )
        """))

        # Insert the latest migration version
        conn.execute(text("DELETE FROM alembic_version"))
        conn.execute(text("INSERT INTO alembic_version (version_num) VALUES ('007')"))
        conn.commit()

        print("✓ Set alembic version to 007")

    print("-" * 50)
    print("✓ Database created successfully!")
    print("You can now start the server.")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(create_fresh_database())
    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
