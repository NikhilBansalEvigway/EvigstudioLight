#!/usr/bin/env python3
"""Fix shared workspace by removing invalid entries and showing how to share existing conversations"""
import sqlite3
from pathlib import Path

# Database paths
evig_db = Path.home() / ".openhands" / "evig_studio.db"
openhands_db = Path.home() / ".openhands" / "openhands.db"

print("=" * 80)
print("FIXING SHARED WORKSPACE ISSUE")
print("=" * 80)

# Connect to both databases
evig_conn = sqlite3.connect(str(evig_db))
openhands_conn = sqlite3.connect(str(openhands_db))

evig_cursor = evig_conn.cursor()
openhands_cursor = openhands_conn.cursor()

# Step 1: Remove invalid shared workspace entries
print("\n1. Checking for invalid shared workspace entries...")
evig_cursor.execute("SELECT id, conversation_id, group_id FROM group_workspaces")
invalid_entries = []

for row in evig_cursor.fetchall():
    share_id, conv_id, group_id = row
    # Check if conversation exists
    openhands_cursor.execute(
        "SELECT conversation_id FROM conversation_metadata WHERE conversation_id = ?",
        (conv_id,)
    )
    if not openhands_cursor.fetchone():
        invalid_entries.append((share_id, conv_id, group_id))
        print(f"   Found invalid entry: {conv_id} (does not exist in database)")

if invalid_entries:
    print(f"\n   Found {len(invalid_entries)} invalid entries. Removing them...")
    for share_id, conv_id, group_id in invalid_entries:
        evig_cursor.execute("DELETE FROM group_workspaces WHERE id = ?", (share_id,))
        print(f"   Removed invalid entry for conversation {conv_id}")
    evig_conn.commit()
    print("   All invalid entries removed!")
else:
    print("   No invalid entries found!")

# Step 2: Show available conversations that can be shared
print("\n2. Available conversations that can be shared:")
print("-" * 80)

openhands_cursor.execute("""
    SELECT conversation_id, title, created_by_user_id
    FROM conversation_metadata
    WHERE conversation_version = 'V1'
    ORDER BY created_at DESC
    LIMIT 10
""")

conversations = openhands_cursor.fetchall()
for i, (conv_id, title, owner) in enumerate(conversations, 1):
    print(f"{i}. ID: {conv_id}")
    print(f"   Title: {title}")
    print(f"   Owner: {owner}")
    print()

# Step 3: Show groups
print("\n3. Available groups:")
print("-" * 80)

evig_cursor.execute("SELECT id, name, description FROM groups")
groups = evig_cursor.fetchall()

for group_id, name, desc in groups:
    print(f"Group: {name}")
    print(f"  ID: {group_id}")
    print(f"  Description: {desc}")

    # Show members
    evig_cursor.execute("""
        SELECT user_id, role FROM group_members WHERE group_id = ?
    """, (group_id,))
    members = evig_cursor.fetchall()
    print(f"  Members: {len(members)}")
    for user_id, role in members:
        print(f"    - {user_id} ({role})")
    print()

# Step 4: Instructions
print("\n4. HOW TO SHARE A CONVERSATION:")
print("-" * 80)
print("To share a conversation with a group, use the Admin Panel:")
print("1. Go to Admin Panel -> Groups")
print("2. Select the group you want to share with")
print("3. Click 'Share Workspace'")
print("4. Enter one of the conversation IDs from the list above")
print("5. Choose access level: view, edit, or admin")
print()
print("The member will then see the shared conversation in their conversation list!")
print()

print("=" * 80)
print("DONE!")
print("=" * 80)

evig_conn.close()
openhands_conn.close()
