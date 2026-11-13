import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

/** The rate limit counter: one statement counts and checks. */

let db: PGlite;

const allow = async (key: string, limit: number, seconds = 600): Promise<boolean> =>
  (await db.query<{ ok: boolean }>("select public.check_rate_limit($1, $2, $3) as ok", [key, limit, seconds]))
    .rows[0]!.ok;

beforeAll(async () => {
  db = await createDatabase();
}, 60_000);

describe("check_rate_limit", () => {
  it("allows up to the limit in a window, then refuses", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await allow("form:abc", 3));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("counts each key on its own", async () => {
    expect(await allow("form:one", 1)).toBe(true);
    expect(await allow("form:one", 1)).toBe(false);
    expect(await allow("form:two", 1)).toBe(true);
    expect(await allow("upload:one", 1)).toBe(true);
  });

  it("starts again in the next window", async () => {
    expect(await allow("form:window", 1)).toBe(true);
    expect(await allow("form:window", 1)).toBe(false);
    // Move the counter into the past, as time passing would.
    await db.query("update rate_limits set window_start = window_start - interval '1 hour' where key = 'form:window'");
    expect(await allow("form:window", 1)).toBe(true);
  });

  it("keeps one row per key and window however many requests arrive together", async () => {
    await Promise.all(Array.from({ length: 20 }, () => allow("form:burst", 100)));
    const { rows } = await db.query<{ rows: number; total: number }>(
      "select count(*)::int as rows, sum(count)::int as total from rate_limits where key = 'form:burst'",
    );
    expect(rows[0]).toEqual({ rows: 1, total: 20 });
  });

  it("refuses a missing key, a zero limit and a zero window", async () => {
    await expect(allow("", 3)).rejects.toThrow(/needs a key/);
    await expect(allow("form:x", 0)).rejects.toThrow(/needs a key/);
    await expect(allow("form:x", 3, 0)).rejects.toThrow(/needs a key/);
  });

  it("shortens an overlong key instead of failing", async () => {
    expect(await allow("k".repeat(500), 5)).toBe(true);
    const { rows } = await db.query<{ n: number }>("select max(length(key))::int as n from rate_limits");
    expect(rows[0]!.n).toBe(200);
  });
});

describe("delete_old_rate_limits", () => {
  it("removes counters older than a day and keeps the rest", async () => {
    await allow("form:old", 5);
    await allow("form:fresh", 5);
    await db.query("update rate_limits set window_start = now() - interval '2 days' where key = 'form:old'");
    await db.query("select public.delete_old_rate_limits()");
    const { rows } = await db.query<{ key: string }>(
      "select key from rate_limits where key in ('form:old', 'form:fresh')",
    );
    expect(rows).toEqual([{ key: "form:fresh" }]);
  });
});

describe("who may use it", () => {
  it("refuses the public and signed-in accounts; the service role may", async () => {
    await db.exec(
      "insert into staff (email, role) values ('admin@adventure-access.com', 'admin') on conflict do nothing",
    );
    for (const sql of ["select public.check_rate_limit('x', 1, 60)", "select public.delete_old_rate_limits()"]) {
      await expect(as(db, { role: "anon" }, () => db.query(sql))).rejects.toThrow(/permission denied/);
      await expect(
        as(db, { role: "authenticated", email: "admin@adventure-access.com" }, () => db.query(sql)),
      ).rejects.toThrow(/permission denied/);
      await expect(as(db, { role: "service_role" }, () => db.query(sql))).resolves.toBeDefined();
    }
  });
});
