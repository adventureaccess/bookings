import { createSign } from "node:crypto";

/**
 * A small Google Drive client: sign in as a service account and upload one
 * file into one folder. Nothing else. No Google SDK, so there is little
 * here that can do more than that.
 *
 * The service account is a member of one Shared Drive only, so although the
 * token's scope is Drive, the only place it can reach is that drive.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id";
const SCOPE = "https://www.googleapis.com/auth/drive";

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

/** Reads the service account key: the JSON file's contents, as is or base64-encoded. */
export function parseServiceAccountKey(raw: string): ServiceAccount | null {
  const text = raw.trim();
  for (const candidate of [text, safeBase64(text)]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        const { client_email, private_key } = parsed as Record<string, unknown>;
        if (
          typeof client_email === "string" &&
          client_email.includes("@") &&
          typeof private_key === "string" &&
          private_key.includes("PRIVATE KEY")
        ) {
          return { client_email, private_key };
        }
      }
    } catch {
      // not JSON in this form; try the next
    }
  }
  return null;
}

function safeBase64(text: string): string | null {
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(text)) return null;
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return null;
  }
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** The signed request a service account sends to get an access token. Valid for an hour. */
export function signedJwt(account: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

type Fetch = typeof fetch;

export async function getAccessToken(
  account: ServiceAccount,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt(account, Math.floor(now.getTime() / 1000)),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new DriveError("Google refused the service account", response.status);
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new DriveError("Google sent no access token");
  return body.access_token;
}

export interface DriveUpload {
  account: ServiceAccount;
  /** The Shared Drive, or a folder inside it, that files go into. */
  folderId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  fetchImpl?: Fetch;
}

/** Uploads one file and returns its Drive file ID. */
export async function uploadToDrive(upload: DriveUpload): Promise<{ id: string }> {
  const fetchImpl = upload.fetchImpl ?? fetch;
  const token = await getAccessToken(upload.account, fetchImpl);

  const boundary = `aa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: upload.name, parents: [upload.folderId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${upload.mime}\r\n\r\n`,
    ),
    Buffer.from(upload.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await fetchImpl(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new DriveError("Google Drive refused the upload", response.status);
  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== "string" || result.id === "") {
    throw new DriveError("Google Drive sent no file ID");
  }
  return { id: result.id };
}

export interface DriveCheck {
  ok: boolean;
  /** A plain sentence for staff. Never contains the key or a file's contents. */
  message: string;
}

/**
 * Tries the connection without adding a file: signs in as the service
 * account, then looks at the folder. Says which step failed.
 */
export async function checkDriveConnection(
  account: ServiceAccount,
  folderId: string,
  fetchImpl: Fetch = fetch,
): Promise<DriveCheck> {
  let token: string;
  try {
    token = await getAccessToken(account, fetchImpl);
  } catch (error) {
    if (error instanceof DriveError && error.status) {
      return {
        ok: false,
        message: `Google did not accept the service account key (status ${error.status}). The key may be deleted or disabled, or the Drive API is not switched on for its project.`,
      };
    }
    return {
      ok: false,
      message:
        "The service account key could not be used to sign in. It may have been cut off or changed when it was pasted. Paste the whole JSON file again.",
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,mimeType,driveId,capabilities(canAddChildren)`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    return { ok: false, message: "Google Drive did not answer. Try again in a moment." };
  }
  if (response.status === 404) {
    return {
      ok: false,
      message:
        "The key works, but the service account cannot see that folder. Either the folder ID is wrong, or the service account has not been added to the Shared Drive as a member.",
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      message:
        "The key works, but Google refused the request (status 403). Most often the Google Drive API is not enabled for the service account's project.",
    };
  }
  if (!response.ok) {
    return { ok: false, message: `Google Drive refused the request (status ${response.status}).` };
  }
  const folder = (await response.json()) as {
    mimeType?: unknown;
    driveId?: unknown;
    capabilities?: { canAddChildren?: unknown };
  };
  if (folder.mimeType !== "application/vnd.google-apps.folder") {
    return { ok: false, message: "That ID is a file, not a folder or a Shared Drive." };
  }
  if (folder.capabilities?.canAddChildren !== true) {
    return {
      ok: false,
      message:
        "The service account can see the folder but may not add files. Make it a Contributor on the Shared Drive.",
    };
  }
  if (typeof folder.driveId !== "string") {
    return {
      ok: false,
      message:
        "The folder is in someone's My Drive, not a Shared Drive. A service account cannot store files there. Use a folder in the Shared Drive.",
    };
  }
  return { ok: true, message: "Connected. The service account can add files to the Shared Drive." };
}

/** Where staff open a file, with their own Google sign-in. */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}
