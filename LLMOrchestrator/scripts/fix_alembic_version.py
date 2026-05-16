#!/usr/bin/env python3
"""
Fix alembic version mismatch.

This script resets the alembic_version table to '007' (the latest OSS migration)
when the database incorrectly references '008' (an enterprise-only migration).
"""

import sqlite3
from pathlib import Path
import os
import sys

# Get the database path - check both Windows and WSL locations
home = Path.home()
db_path_windows = home / '.evigstudio' / 'openhands.db'
db_path_wsl = Path('/home') / os.getenv('USER', 'ritikmahapatra') / '.evigstudio' / 'openhands.db'

# Try to find the database
if db_path_windows.exists():
    db_path = db_path_windows
elif db_path_wsl.exists():
    db_path = db_path_wsl
else:
    # Allow manual path as argument
    if len(sys.argv) > 1:
        db_path = Path(sys.argv[1])
    else:
        print(f"❌ Database not found at:")
        print(f"   - {db_path_windows}")
        print(f"   - {db_path_wsl}")
        print(f"\nUsage: python {sys.argv[0]} [path/to/openhands.db]")
        exit(1)

print(f"🔍 Database path: {db_path}")

if not db_path.exists():
    print("❌ Database file not found!")
    exit(1)

# Connect to the database
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    # Check current version
    cursor.execute("SELECT version_num FROM alembic_version")
    current_version = cursor.fetchone()

    if current_version:
        print(f"📊 Current alembic version: {current_version[0]}")

        if current_version[0] == '008':
            print("🔧 Fixing version from '008' to '007'...")
            cursor.execute("UPDATE alembic_version SET version_num = '007'")
            conn.commit()
            print("✅ Successfully updated alembic version to '007'")
        else:
            print(f"ℹ️  Version is already '{current_version[0]}', no fix needed")
    else:
        print("⚠️  No version found in alembic_version table")
        print("🔧 Inserting version '007'...")
        cursor.execute("INSERT INTO alembic_version (version_num) VALUES ('007')")
        conn.commit()
        print("✅ Successfully set alembic version to '007'")

except sqlite3.OperationalError as e:
    if "no such table" in str(e):
        print("⚠️  alembic_version table doesn't exist yet")
        print("🔧 Creating table and setting version to '007'...")
        cursor.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        cursor.execute("INSERT INTO alembic_version (version_num) VALUES ('007')")
        conn.commit()
        print("✅ Successfully created table and set version to '007'")
    else:
        print(f"❌ Error: {e}")
        raise
finally:
    conn.close()

print("\n✅ Done! You can now start the server.")
