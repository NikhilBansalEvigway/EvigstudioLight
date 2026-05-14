#!/usr/bin/env python3
"""Check what conversations exist in the database"""
import sqlite3
from pathlib import Path

db_path = Path.home() / ".openhands" / "openhands.db"
conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()

print("=" * 80)
print("CONVERSATIONS IN DATABASE")
print("=" * 80)

cursor.execute("""
    SELECT conversation_id, title, created_by_user_id, conversation_version
    FROM conversation_metadata
    ORDER BY created_at DESC
    LIMIT 20
""")

rows = cursor.fetchall()
print(f"\nTotal conversations: {len(rows)}\n")

for row in rows:
    conv_id, title, user_id, version = row
    print(f"ID: {conv_id}")
    print(f"  Title: {title}")
    print(f"  Owner: {user_id}")
    print(f"  Version: {version}")
    print()

print("=" * 80)
print("CHECKING SHARED CONVERSATION")
print("=" * 80)

shared_id = "48725ac4eb724f75ab812dd42b7db891"
cursor.execute("""
    SELECT conversation_id, title, created_by_user_id, conversation_version
    FROM conversation_metadata
    WHERE conversation_id = ?
""", (shared_id,))

result = cursor.fetchone()
if result:
    print(f"✅ Conversation {shared_id} EXISTS")
    print(f"   Title: {result[1]}")
    print(f"   Owner: {result[2]}")
    print(f"   Version: {result[3]}")
else:
    print(f"❌ Conversation {shared_id} DOES NOT EXIST in database!")
    print("   This is why users can't access it.")

conn.close()
