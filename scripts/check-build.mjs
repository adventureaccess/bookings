// Fails if a development-only shortcut survived into the built app.
//
// src/lib/auth/resolve.ts lets a developer act as a staff member locally,
// without Google sign-in, by setting DEV_STAFF_EMAIL. That code sits behind
// `import.meta.env.DEV`, which is false in every build, so the bundler removes
// it. This script proves it did: run it after `npm run build`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MARKERS = ["DEV_STAFF_EMAIL", "LOCAL_DOCUMENT_STAND_IN", ".local-documents"];
const ROOTS = ["dist", join(".netlify", "v1"), join(".netlify", "build")];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* walk(path);
    } else if (/\.(m?js|cjs|json|html)$/.test(entry.name)) {
      yield path;
    }
  }
}

const roots = ROOTS.filter((root) => existsSync(root));
if (!roots.includes("dist")) {
  console.error("No dist folder. Run `npm run build` first.");
  process.exit(1);
}

const hits = [];
let scanned = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    scanned += 1;
    const text = readFileSync(file, "utf8");
    for (const marker of MARKERS) {
      if (text.includes(marker)) hits.push(`${file}: contains ${marker}`);
    }
  }
}

if (hits.length > 0) {
  console.error("Development-only code reached the build:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`Build is clean: ${scanned} files scanned, no development shortcuts.`);
