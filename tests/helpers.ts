import { Client, Pool } from "pg";
import { migrate } from "../scripts/migrate";

/** Drops and recreates the test database's public schema, then migrates it fresh. */
export async function freshDb(): Promise<Pool> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrate(url, () => {});
  return new Pool({ connectionString: url, max: 4 });
}
