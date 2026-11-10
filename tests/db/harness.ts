import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * What Supabase provides before our migrations run: the three API roles, the
 * auth.jwt() helper and the extensions schema. Migrations then run as a plain
 * role that is neither superuser nor allowed to bypass RLS, which is stricter
 * than Supabase and keeps the policies from leaning on special privileges.
 */
const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role migrator nologin;

  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  grant usage on schema auth to public;

  create schema extensions;
  grant usage on schema extensions to public;
  grant all on schema extensions to migrator;
  grant all on schema public to migrator;
  grant create on database postgres to migrator;
  grant anon, authenticated, service_role to migrator with admin option;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** A fresh in-process Postgres with every migration applied, in order. */
export async function createDatabase(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIM);
  await db.exec("set role migrator");
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  await db.exec("reset role");
  return db;
}

type Caller =
  | { role: "anon" }
  | { role: "service_role" }
  | { role: "authenticated"; email: string };

/** Runs fn as the given API role, the way PostgREST would, then resets. */
export async function as<T>(
  db: PGlite,
  caller: Caller,
  fn: () => Promise<T>,
): Promise<T> {
  const claims =
    caller.role === "authenticated"
      ? JSON.stringify({ role: "authenticated", email: caller.email })
      : JSON.stringify({ role: caller.role });
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await db.exec(`set role ${caller.role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}
