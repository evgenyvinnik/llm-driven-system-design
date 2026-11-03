/**
 * Environment configuration with local-development defaults, so a fresh clone
 * runs without a .env file.
 * @module shared/config
 */
const store = process.env.FS_STORE === 'memory' ? 'memory' : 'postgres'

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** `postgres` (default) or `memory`. */
  store: store as 'memory' | 'postgres',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/file_system',
  /** Database the PostgreSQL conformance tests create and wipe; never the dev database. */
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgresql://user:password@localhost:5432/file_system_test',
}
