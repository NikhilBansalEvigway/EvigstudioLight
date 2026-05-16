#!/bin/bash
DB="/home/ritikmahapatra/.openhands/evig_studio.db"

echo "=== Current users ==="
sqlite3 "$DB" "SELECT u.user_id, u.email, r.name as role, u.status FROM users u LEFT JOIN roles r ON r.id=u.role_id;"

echo ""
echo "=== Promoting admin@hrm.com to Admin role (role_id=1) ==="
sqlite3 "$DB" "UPDATE users SET role_id=1 WHERE email='admin@hrm.com';"

echo ""
echo "=== After promotion ==="
sqlite3 "$DB" "SELECT u.email, r.name as role FROM users u LEFT JOIN roles r ON r.id=u.role_id;"
echo "Done! Please log in with admin@hrm.com"
