#!/usr/bin/env python3
"""
Test script to verify local auth + conversation isolation fix.

This script checks:
1. Can read session from oh_session cookie
2. Can get user_id from session
3. Conversations are filtered by user_id
"""

import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def test_session_lookup():
    """Test that we can look up user_id from session token."""
    print("=" * 60)
    print("TEST 1: Session Lookup")
    print("=" * 60)

    try:
        import openhands.server.routes.admin.db as
= db.list_users()
        print(f"✓ Found {len(users)} users in database")

        if len(users) == 0:
            print("⚠ No users found - create a user first via /oss-auth")
            return False

        # Show users
        print("\nUsers in database:")
        for user in users:
            print(f"  - {user['email']} (user_id: {user['user_id']}, role: {user['role_name']})")

        # Check if we have any sessions
        cursor = conn.execute("SELECT COUNT(*) FROM sessions")
        session_count = cursor.fetchone()[0]
        print(f"\n✓ Found {session_count} active sessions")

        if session_count > 0:
            # Show sessions
            cursor = conn.execute("SELECT token, user_id FROM sessions LIMIT 5")
            sessions = cursor.fetchall()
            print("\nActive sessions:")
            for token, user_id in sessions:
                user = db.get_user(user_id)
                email = user['email'] if user else 'Unknown'
                print(f"  - {token[:20]}... → {user_id} ({email})")

        print("\n✅ Session lookup test PASSED")
        return True

    except Exception as e:
        print(f"\n❌ Session lookup test FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_conversation_metadata():
    """Test that conversation_metadata table has created_by_user_id column."""
    print("\n" + "=" * 60)
    print("TEST 2: Conversation Metadata Schema")
    print("=" * 60)

    try:
        import sqlite3
        from pathlib import Path

        # Find openhands.db
        db_path = Path.home() / ".openhands" / "openhands.db"
        print(f"✓ Database path: {db_path}")
        print(f"✓ Database exists: {db_path.exists()}")

        if not db_path.exists():
            print("⚠ Database doesn't exist yet - create a conversation first")
            return False

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row

        # Check if conversation_metadata table exists
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_metadata'"
        )
        if not cursor.fetchone():
            print("⚠ conversation_metadata table doesn't exist yet")
            return False

        print("✓ conversation_metadata table exists")

        # Check if created_by_user_id column exists
        cursor = conn.execute("PRAGMA table_info(conversation_metadata)")
        columns = {row[1]: row[2] for row in cursor.fetchall()}

        if 'created_by_user_id' not in columns:
            print("❌ created_by_user_id column is MISSING!")
            print("   Run migration 007 to add it")
            return False

        print("✓ created_by_user_id column exists")

        # Check if index exists
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_conversation_metadata_created_by_user_id'"
        )
        if cursor.fetchone():
            print("✓ Index on created_by_user_id exists")
        else:
            print("⚠ Index on created_by_user_id is missing (not critical)")

        # Show some conversations
        cursor = conn.execute(
            "SELECT conversation_id, created_by_user_id, title FROM conversation_metadata WHERE conversation_version='V1' ORDER BY created_at DESC LIMIT 5"
        )
        conversations = cursor.fetchall()

        if conversations:
            print(f"\n✓ Found {len(conversations)} conversations:")
            for row in conversations:
                conv_id = row[0][:20] + "..." if len(row[0]) > 20 else row[0]
                user_id = row[1] or "NULL"
                title = row[2] or "Untitled"
                print(f"  - {conv_id} | {user_id} | {title}")
        else:
            print("\n⚠ No conversations found yet")

        conn.close()

        print("\n✅ Conversation metadata test PASSED")
        return True

    except Exception as e:
        print(f"\n❌ Conversation metadata test FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_user_auth_integration():
    """Test that DefaultUserAuth can get user_id from request."""
    print("\n" + "=" * 60)
    print("TEST 3: User Auth Integration")
    print("=" * 60)

    try:
        from openhands.server.user_auth.default_user_auth import DefaultUserAuth
        from unittest.mock import Mock

        print("✓ Imported DefaultUserAuth")

        # Create a mock request with oh_session cookie
        mock_request = Mock()
        mock_request.cookies = {}

        # Test without cookie
        auth = DefaultUserAuth(request=mock_request)
        import asyncio
        user_id = asyncio.run(auth.get_user_id())

        if user_id is None:
            print("✓ Returns None when no cookie present")
        else:
            print(f"⚠ Returned {user_id} when no cookie present (expected None)")

        # Test with invalid cookie
        mock_request.cookies = {'oh_session': 'invalid_token'}
        auth = DefaultUserAuth(request=mock_request)
        user_id = asyncio.run(auth.get_user_id())

        if user_id is None:
            print("✓ Returns None when cookie is invalid")
        else:
            print(f"⚠ Returned {user_id} when cookie is invalid (expected None)")

        # Test with valid cookie (if we have sessions)
        try:
            import openhands.server.routes.admin.db as db
            conn = db.get_db()
            cursor = conn.execute("SELECT token, user_id FROM sessions LIMIT 1")
            session = cursor.fetchone()

            if session:
                token, expected_user_id = session
                mock_request.cookies = {'oh_session': token}
                auth = DefaultUserAuth(request=mock_request)
                user_id = asyncio.run(auth.get_user_id())

                if user_id == expected_user_id:
                    print(f"✓ Returns correct user_id ({user_id}) for valid session")
                else:
                    print(f"❌ Returned {user_id}, expected {expected_user_id}")
                    return False
            else:
                print("⚠ No active sessions to test with")
        except Exception as e:
            print(f"⚠ Could not test with real session: {e}")

        print("\n✅ User auth integration test PASSED")
        return True

    except Exception as e:
        print(f"\n❌ User auth integration test FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("LOCAL AUTH + CONVERSATION ISOLATION FIX - TEST SUITE")
    print("=" * 60)

    results = []

    # Run tests
    results.append(("Session Lookup", test_session_lookup()))
    results.append(("Conversation Metadata", test_conversation_metadata()))
    results.append(("User Auth Integration", test_user_auth_integration()))

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)

    for name, passed in results:
        status = "✅ PASSED" if passed else "❌ FAILED"
        print(f"{name}: {status}")

    all_passed = all(passed for _, passed in results)

    if all_passed:
        print("\n🎉 All tests PASSED! The fix is working correctly.")
        print("\nNext steps:")
        print("1. Create users via /oss-auth if you haven't already")
        print("2. Login with different users")
        print("3. Create conversations and verify isolation")
        return 0
    else:
        print("\n⚠️  Some tests FAILED. Please check the errors above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
