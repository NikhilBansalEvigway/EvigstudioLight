import { pgClient } from './client.js';

/**
 * Ensures DATABASE_URL is reachable before the HTTP server starts.
 * This project does not use SQLite files on disk for the API — PostgreSQL only.
 */
export async function verifyPostgresOrExit(): Promise<void> {
  const masked = process.env.DATABASE_URL?.replace(/:([^:@/]+)@/, ':****@') ?? '(missing)';

  try {
    await pgClient`SELECT 1`;
  } catch (err) {
    console.error('\n[evigstudio] Cannot connect to PostgreSQL.');
    console.error('  DATABASE_URL:', masked);
    console.error('  Start the database, then retry:');
    console.error('    • Docker: open Docker Desktop, then from repo root run:  docker compose up -d');
    console.error('    • Port 5432 busy? Map another port in docker-compose.yml (e.g. "5433:5432")');
    console.error('      and set DATABASE_URL to ...@127.0.0.1:5433/evigstudio');
    console.error('    • Native Postgres: create DB/user matching DATABASE_URL and ensure the service is running.\n');
    console.error(err);
    process.exit(1);
  }

  console.log('[evigstudio] PostgreSQL OK:', masked);
}
