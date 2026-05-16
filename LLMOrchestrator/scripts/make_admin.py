"""
make_admin.py — Emergency admin recovery script for Evig Studio.

Usage:
    python make_admin.py
    python make_admin.py --email admin@example.com --password secret123
    python make_admin.py --list       # just list all users in the DB

Run from any directory — finds the DB automatically at ~/.openhands/evig_studio.db
"""
import argparse
import getpass
import hashlib
import os
import secrets
import sqlite3
import uuid
from pathlib import Path


DB_PATH = Path(os.environ.get("OPENHANDS_ADMIN_DATA_DIR", str(Path.home() / ".openhands"))) / "evig_studio.db"


def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        print(f"[ERROR] Database not found at: {DB_PATH}")
        print("       Start the backend at least once so it creates the DB, then run this script.")
        raise SystemExit(1)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _hash(password: str) -> str:
    """SHA-256 hash (no passlib needed)."""
    salt = secrets.token_hex(16)
    h = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
    return f"sha256${salt}${h}"


def list_users(conn: sqlite3.Connection) -> None:
    users = conn.execute(
        """SELECT u.user_id, u.email, r.name as role_name, u.status,
                  CASE WHEN uc.user_id IS NOT NULL THEN 'yes' ELSE 'no' END as has_password
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
           LEFT JOIN user_credentials uc ON uc.user_id = u.user_id
           ORDER BY u.created_at"""
    ).fetchall()

    if not users:
        print("[INFO] No users found in the database.")
        return

    print(f"\n{'EMAIL':<35} {'ROLE':<12} {'STATUS':<10} {'HAS PASSWORD'}")
    print("-" * 75)
    for u in users:
        print(f"{(u['email'] or '(no email)'):<35} {u['role_name']:<12} {u['status']:<10} {u['has_password']}")
    print(f"\nTotal: {len(users)} user(s)\n")


def promote_to_admin(conn: sqlite3.Connection, email: str, password: str | None) -> None:
    """Promote an existing user to Admin, optionally resetting their password."""
    user = conn.execute("SELECT * FROM users WHERE LOWER(email)=LOWER(?)", (email,)).fetchone()
    if not user:
        print(f"[ERROR] No user found with email: {email}")
        return

    # Promote to Admin (role_id=1)
    conn.execute("UPDATE users SET role_id=1, status='active' WHERE user_id=?", (user["user_id"],))

    if password:
        hashed = _hash(password)
        conn.execute(
            "INSERT OR REPLACE INTO user_credentials (user_id, hashed_password, updated_at) VALUES (?,?,datetime('now'))",
            (user["user_id"], hashed),
        )
        print(f"[OK] Password updated for {email}")

    conn.commit()
    print(f"[OK] {email} is now an ADMIN. You can log in immediately.")


def create_admin(conn: sqlite3.Connection, email: str, password: str) -> None:
    """Create a brand-new admin user from scratch."""
    existing = conn.execute("SELECT user_id FROM users WHERE LOWER(email)=LOWER(?)", (email,)).fetchone()
    if existing:
        print(f"[INFO] User {email} already exists. Promoting to Admin instead.")
        promote_to_admin(conn, email, password)
        return

    user_id = str(uuid.uuid4())
    hashed = _hash(password)

    conn.execute(
        "INSERT INTO users (user_id, email, role_id, status, created_at) VALUES (?,?,1,'active',datetime('now'))",
        (user_id, email.lower().strip()),
    )
    conn.execute(
        "INSERT INTO user_credentials (user_id, hashed_password, created_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))",
        (user_id, hashed),
    )
    conn.commit()
    print(f"[OK] Admin account created for {email}. You can log in immediately.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evig Studio — Emergency Admin Recovery")
    parser.add_argument("--email",    help="Admin email address")
    parser.add_argument("--password", help="Admin password (or leave blank to be prompted)")
    parser.add_argument("--list",     action="store_true", help="Just list all users and exit")
    parser.add_argument("--promote",  help="Promote this email to Admin (existing user)")
    args = parser.parse_args()

    print(f"\n📦 Database: {DB_PATH}\n")
    conn = connect()

    if args.list:
        list_users(conn)
        return

    # ── List mode if no arguments ──────────────────────────────────────────────
    users = conn.execute("SELECT * FROM users").fetchall()
    if not args.email and not args.promote:
        print("Current users in the database:")
        list_users(conn)

        if not users:
            print("No users exist. Let's create a fresh admin account.\n")
        else:
            print("\nOptions:")
            print("  1. Promote an existing user to Admin")
            print("  2. Create a brand-new admin account")
            choice = input("\nEnter choice [1/2]: ").strip()

            if choice == "1":
                email = input("Email of user to promote: ").strip()
                reset = input("Reset their password too? [y/N]: ").strip().lower()
                password = None
                if reset == "y":
                    password = getpass.getpass("New password (min 6 chars): ")
                promote_to_admin(conn, email, password)
                return
            # Fall through to create new admin

        email = input("New admin email: ").strip()
        password = getpass.getpass("New admin password (min 6 chars): ")
        if len(password) < 6:
            print("[ERROR] Password must be at least 6 characters.")
            raise SystemExit(1)
        create_admin(conn, email, password)
        return

    # ── Promote mode ───────────────────────────────────────────────────────────
    if args.promote:
        password = args.password or getpass.getpass("New password (leave blank to keep current): ") or None
        promote_to_admin(conn, args.promote, password)
        return

    # ── Create / promote by email ──────────────────────────────────────────────
    email = args.email
    password = args.password or getpass.getpass(f"Password for {email} (min 6 chars): ")
    if len(password) < 6:
        print("[ERROR] Password must be at least 6 characters.")
        raise SystemExit(1)

    user_exists = conn.execute("SELECT user_id FROM users WHERE LOWER(email)=LOWER(?)", (email,)).fetchone()
    if user_exists:
        promote_to_admin(conn, email, password)
    else:
        create_admin(conn, email, password)


if __name__ == "__main__":
    main()
