/**
 * Reset a user's password (bcrypt, same as the API).
 * Uses DATABASE_URL from server/.env — PostgreSQL only.
 *
 *   cd server && node scripts/set-password.mjs <email> "<new-password>"
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: node scripts/set-password.mjs <email> "<new-password>"');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url?.startsWith('postgres')) {
  console.error('DATABASE_URL must be set to a postgresql://... URL in server/.env');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 10);
const postgres = (await import('postgres')).default;
const sql = postgres(url, { max: 1 });
try {
  const rows = await sql`
    UPDATE users SET password_hash = ${hash}
    WHERE lower(email) = lower(${email})
    RETURNING email
  `;
  if (rows.length === 0) {
    console.error(`No user matched email: ${email}`);
    process.exit(1);
  }
  console.log(`Password updated for ${rows[0].email}`);
} finally {
  await sql.end();
}
