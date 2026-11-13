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

/** Where staff open a file, with their own Google sign-in. */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}
