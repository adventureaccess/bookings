// Fails if any NEXT_PUBLIC_ name looks like a secret, or if a public name
// appears that is not on the short allowlist. Runs in CI.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ALLOWED = new Set([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
]);
const FORBIDDEN = /SECRET|SERVICE|TOKEN|PRIVATE|PASSWORD/;
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".yml", ".yaml"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".netlify", "coverage"]);
const SELF = join("scripts", "check-public-env.mjs");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path);
    } else if (
      path !== SELF &&
      entry.name !== "package-lock.json" &&
      (SCAN_EXTENSIONS.has(extname(entry.name)) || entry.name.startsWith(".env"))
    ) {
      yield path;
    }
  }
}

const problems = [];
for (const file of walk(".")) {
  const names = readFileSync(file, "utf8").match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? [];
  for (const name of new Set(names)) {
    if (FORBIDDEN.test(name)) {
      problems.push(`${file}: ${name} looks like a secret and must not be public`);
    } else if (!ALLOWED.has(name)) {
      problems.push(`${file}: ${name} is not on the public allowlist`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("Public environment names are clean.");
