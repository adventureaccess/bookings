import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GOOGLE_DRIVE_FOLDER_ID, GOOGLE_SERVICE_ACCOUNT_KEY } from "astro:env/server";
import { checkDriveConnection, parseServiceAccountKey, uploadToDrive, type DriveCheck } from "../drive/client";

/**
 * Where uploaded traveler documents go. In production that is the restricted
 * Google Shared Drive and nowhere else: the app keeps only the file ID it
 * gets back.
 *
 * On a developer's machine, when Drive is not set up, files go to a local
 * folder instead so the upload flow can be built and tested. That stand-in
 * exists only in the dev server: it sits behind `import.meta.env.DEV`, every
 * build strips it out, and `npm run check:build` fails if it ever survives.
 */

export interface DocumentStore {
  /** "drive" in production; "local" is the dev-only stand-in. */
  name: "drive" | "local";
  upload(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ id: string }>;
}

function driveStore(): DocumentStore | null {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY || !GOOGLE_DRIVE_FOLDER_ID) return null;
  const account = parseServiceAccountKey(GOOGLE_SERVICE_ACCOUNT_KEY);
  if (!account) {
    console.error("[documents] GOOGLE_SERVICE_ACCOUNT_KEY is set but is not a service account key");
    return null;
  }
  const folderId = GOOGLE_DRIVE_FOLDER_ID;
  return {
    name: "drive",
    upload: (file) => uploadToDrive({ account, folderId, ...file }),
  };
}

/** The store to use, or null when uploads are not switched on. */
export function documentStore(): DocumentStore | null {
  const drive = driveStore();
  if (drive) return drive;

  if (import.meta.env.DEV) {
    // LOCAL_DOCUMENT_STAND_IN: dev server only. Never part of a build.
    const folder = join(process.cwd(), ".local-documents");
    return {
      name: "local",
      async upload(file) {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, file.name), file.bytes);
        return { id: `local:${file.name}` };
      },
    };
  }
  return null;
}

/** For the admin: is the Shared Drive reachable, and if not, which step fails. Adds no file. */
export async function checkDocumentStore(): Promise<DriveCheck> {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY || !GOOGLE_DRIVE_FOLDER_ID) {
    return {
      ok: false,
      message: `Not set up: ${!GOOGLE_SERVICE_ACCOUNT_KEY ? "GOOGLE_SERVICE_ACCOUNT_KEY" : "GOOGLE_DRIVE_FOLDER_ID"} is missing in Netlify.`,
    };
  }
  const account = parseServiceAccountKey(GOOGLE_SERVICE_ACCOUNT_KEY);
  if (!account) {
    return {
      ok: false,
      message:
        "GOOGLE_SERVICE_ACCOUNT_KEY is set but is not a service account key. Paste the whole JSON file Google gave you.",
    };
  }
  return checkDriveConnection(account, GOOGLE_DRIVE_FOLDER_ID);
}
