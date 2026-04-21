import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL ?? 'postgresql://evigstudio:evigstudio@127.0.0.1:5432/evigstudio';
if (url.startsWith('file:') || url.includes('sqlite')) {
  throw new Error(
    '[drizzle] This project uses PostgreSQL only. Set DATABASE_URL=postgresql://... in server/.env — not SQLite.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
});
