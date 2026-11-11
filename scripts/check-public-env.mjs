// Fails if any browser-exposed environment variable name appears in the repo.
//
// Astro sends variables prefixed PUBLIC_ to the browser. This app reads every
// variable on the server, so the allowlist is empty: adding a PUBLIC_ name is
// a deliberate decision that has to be made here, in review. Runs in CI.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ALLOWED = new Set([]);
const PUBLIC_NAME = /\b(?:NEXT_)?PUBLIC_[A-Z0-9_]+/g;
const FORBIDDEN = /SECRET|SERVICE|TOKEN|PRIVATE|PASSWORD|KEY/;
const SCAN_EXTENSIONS = new Set([
  ".astro", ".ts", ".tsx", ".js", ".mjs", ".json", ".yml", ".yaml", ".toml",
]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".astro", ".git", ".netlify", "coverage",
]);
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
  // Never print values: only names are reported.
  const names = readFileSync(file, "utf8").match(PUBLIC_NAME) ?? [];
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
console.log("No browser-exposed environment names found.");
