/**
 * Migration runner.
 *
 * Applies init.sql to DATABASE_URL. Docker Compose already runs init.sql when
 * it creates a fresh volume; this brings an existing volume up to date (every
 * statement is IF NOT EXISTS, so re-running is safe).
 *
 * @module db/migrate
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import db from "./index.js";

async function migrate(): Promise<void> {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "init.sql"), "utf-8");
    await db.pool.query(sql);
    console.log("Database migration completed successfully");
    await db.pool.end();
    process.exit(0);
  } catch (error) {
    console.error("Database migration failed:", error);
    process.exit(1);
  }
}

migrate();
