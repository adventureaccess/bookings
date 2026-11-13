import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkDriveConnection } from "./client";

// A throwaway key made for this test run. It signs nothing real.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  client_email: "uploader@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A stand-in for Google: one answer for the token, one for the folder. */
function google(token: Response, folder?: Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2")) return token.clone();
    if (!folder) throw new Error("the folder should not be asked for");
    return folder.clone();
  }) as typeof fetch;
}

const goodToken = json(200, { access_token: "t" });
const folder = (extra: Record<string, unknown>) =>
  json(200, { id: "f", mimeType: "application/vnd.google-apps.folder", ...extra });

describe("checkDriveConnection", () => {
  it("passes when the service account may add files to a Shared Drive folder", async () => {
    const result = await checkDriveConnection(
      account,
      "folder1",
      google(goodToken, folder({ driveId: "d", capabilities: { canAddChildren: true } })),
    );
    expect(result.ok).toBe(true);
  });

  it("says the key was refused, with the status, and stops there", async () => {
    const result = await checkDriveConnection(account, "folder1", google(json(400, { error: "invalid_grant" })));
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("status 400");
  });

  it("says a key that cannot sign was pasted wrong", async () => {
    const broken = { ...account, private_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n" };
    const result = await checkDriveConnection(broken, "folder1", google(goodToken));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Paste the whole JSON file again");
  });

  it("says when the folder cannot be seen", async () => {
    const result = await checkDriveConnection(account, "folder1", google(goodToken, json(404, {})));
    expect(result.message).toContain("cannot see that folder");
  });

  it("says when the Drive API is refused", async () => {
    const result = await checkDriveConnection(account, "folder1", google(goodToken, json(403, {})));
    expect(result.message).toContain("status 403");
  });

  it("says when the account can look but not add", async () => {
    const result = await checkDriveConnection(
      account,
      "folder1",
      google(goodToken, folder({ driveId: "d", capabilities: { canAddChildren: false } })),
    );
    expect(result.message).toContain("may not add files");
  });

  it("says when the folder is in a personal My Drive", async () => {
    const result = await checkDriveConnection(
      account,
      "folder1",
      google(goodToken, folder({ capabilities: { canAddChildren: true } })),
    );
    expect(result.message).toContain("not a Shared Drive");
  });

  it("never repeats the key or the account in its message", async () => {
    const result = await checkDriveConnection(account, "folder1", google(json(401, {})));
    expect(result.message).not.toContain(account.client_email);
    expect(result.message).not.toContain("PRIVATE KEY");
  });
});
