#!/usr/bin/env python3
"""Reset migration 101 state in the database"""
import pg8000

db_host = 'localhost'
db_port = 5432
db_name = 'evigstudio'
db_user = 'postgres'
db_pass = 'admin'

print(f"Connecting to PostgreSQL at {db_host}:{db_port}/{db_name}...")

try:
    conn = pg8000.connect(host=db_host, port=db_port, database=db_name, user=db_user, password=db_pass)
    conn.autocommit = True
    cursor = conn.cursor()

    cursor.execute("SELECT version_num FROM alembic_version;")
    current_version = cursor.fetchone()
    print(f"Current version: {current_version[0] if current_version else 'None'}")

    if current_version and current_version[0] == '101':
        print("Rolling back to version 100...")
        cursor.execute("UPDATE alembic_version SET version_num = '100';")
        print("✓ Rolled back to 100")

    cursor.close()
    conn.close()
    print("✅ Done! Restart the app to run migration 101.")

except Exception as e:
    print(f"❌ Error: {e}")
    exit(1)
