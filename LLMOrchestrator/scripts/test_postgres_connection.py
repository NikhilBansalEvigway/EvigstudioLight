#!/usr/bin/env python3
"""Test PostgreSQL connection"""
import os
from dotenv import load_dotenv
import psycopg2

# Load environment variables
load_dotenv()

# Get database configuration
db_host = os.getenv('DB_HOST', 'postgres16')
db_port = os.getenv('DB_PORT', '5432')
db_name = os.getenv('DB_NAME', 'evigstudio')
db_user = os.getenv('DB_USER', 'postgres')
db_pass = os.getenv('DB_PASS', 'admin')

print(f"Testing connection to PostgreSQL:")
print(f"  Host: {db_host}")
print(f"  Port: {db_port}")
print(f"  Database: {db_name}")
print(f"  User: {db_user}")

try:
    conn = psycopg2.connect(
        host=db_host,
        port=db_port,
        database=db_name,
        user=db_user,
        password=db_pass
    )
    print("\n✓ Connection successful!")

    # Test query
    cursor = conn.cursor()
    cursor.execute("SELECT version();")
    version = cursor.fetchone()
    print(f"✓ PostgreSQL version: {version[0]}")

    cursor.close()
    conn.close()

except Exception as e:
    print(f"\n✗ Connection failed: {e}")
    exit(1)
