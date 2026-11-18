/**
 * Loads made-up demo listings into a LOCAL database for working on pages.
 * Refuses to run against anything that is not localhost.
 * Usage: npm run db:dev-seed
 */
import { getPool, closePool } from "../src/lib/db";
import { seedDemo } from "../tests/fixtures";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("db:dev-seed only runs against a local database");
  process.exit(1);
}
seedDemo(getPool())
  .then(() => console.log("demo listings loaded"))
  .then(closePool)
  .catch((err) => { console.error(err); process.exit(1); });
