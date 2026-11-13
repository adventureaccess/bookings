import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DriveError,
  driveFileUrl,
  parseServiceAccountKey,
  signedJwt,
  uploadToDrive,
} from "../drive/client";
import { checkUpload, documentFileName, MAX_UPLOAD_BYTES, sniffFileType } from "./files";

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00];
const file = (bytes: number[] | Uint8Array, name = "upload.bin", type = "") =>
  new File([new Uint8Array(bytes)], name, { type });

describe("sniffFileType", () => {
  it("recognizes PDF, JPEG and PNG from their first bytes", () => {
    expect(sniffFileType(new Uint8Array(PDF))).toEqual({ mime: "application/pdf", extension: "pdf" });
    expect(sniffFileType(new Uint8Array(JPEG))).toEqual({ mime: "image/jpeg", extension: "jpg" });
    expect(sniffFileType(new Uint8Array(PNG))).toEqual({ mime: "image/png", extension: "png" });
  });

  it("recognizes nothing else", () => {
    const exe = [0x4d, 0x5a, 0x90, 0x00];
    const zip = [0x50, 0x4b, 0x03, 0x04];
    const html = [...Buffer.from("<html><script>")];
    for (const bytes of [exe, zip, html, [], [0x25, 0x50]]) {
      expect(sniffFileType(new Uint8Array(bytes))).toBeNull();
    }
  });
});

describe("checkUpload", () => {
  it("accepts a real PDF, JPEG or PNG", async () => {
    for (const bytes of [PDF, JPEG, PNG]) {
      expect((await checkUpload(file(bytes))).ok).toBe(true);
    }
  });

  it("goes by content, not by the name or type the browser gives", async () => {
    const disguised = await checkUpload(file([0x4d, 0x5a, 0x90, 0x00], "passport.pdf", "application/pdf"));
    expect(disguised).toEqual({
      ok: false,
      message: "Send a PDF, JPG or PNG. Other kinds of file are not accepted.",
    });
    const misnamed = await checkUpload(file(PDF, "scan.exe", "application/x-msdownload"));
    expect(misnamed.ok && misnamed.type.extension).toBe("pdf");
  });

  it("refuses a missing or empty file and one over the size limit", async () => {
    expect(await checkUpload(null)).toEqual({ ok: false, message: "Choose a file first." });
    expect(await checkUpload("not a file")).toEqual({ ok: false, message: "Choose a file first." });
    expect((await checkUpload(file([]))).ok).toBe(false);

    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PDF);
    const result = await checkUpload(file(big));
    expect(result).toEqual({
      ok: false,
      message: "That file is larger than 4 MB. Send a smaller scan or photo.",
    });
  });

  it("can be limited to PDFs, for the waiver", async () => {
    expect((await checkUpload(file(PDF), ["application/pdf"])).ok).toBe(true);
    expect(await checkUpload(file(JPEG), ["application/pdf"])).toEqual({
      ok: false,
      message: "That file is not a PDF.",
    });
  });
});

describe("documentFileName", () => {
  const base = {
    reference: "AA-7K3Q",
    firstName: "Tenzin",
    lastName: "Norbu",
    kind: "passport" as const,
    extension: "pdf" as const,
    date: "2026-11-12",
  };

  it("names a file so staff can find it", () => {
    expect(documentFileName(base)).toBe("AA-7K3Q_Norbu-Tenzin_passport_2026-11-12.pdf");
  });

  it("keeps only letters and digits from names, so nothing can break out of the folder", () => {
    expect(
      documentFileName({ ...base, firstName: "../../etc", lastName: "O'Brien <script>" }),
    ).toBe("AA-7K3Q_O-Brien-script-etc_passport_2026-11-12.pdf");
    expect(documentFileName({ ...base, firstName: "José", lastName: "Müller" })).toBe(
      "AA-7K3Q_Mu-ller-Jose_passport_2026-11-12.pdf",
    );
    expect(documentFileName({ ...base, firstName: "山田", lastName: "太郎" })).toBe(
      "AA-7K3Q_traveler_passport_2026-11-12.pdf",
    );
  });
});

describe("Drive client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    client_email: "uploader@example-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  it("reads a service account key as JSON or base64, and rejects anything else", () => {
    const json = JSON.stringify({ type: "service_account", ...account });
    expect(parseServiceAccountKey(json)).toEqual(account);
    expect(parseServiceAccountKey(Buffer.from(json).toString("base64"))).toEqual(account);
    expect(parseServiceAccountKey("not a key")).toBeNull();
    expect(parseServiceAccountKey(JSON.stringify({ client_email: "x@y.z" }))).toBeNull();
    expect(parseServiceAccountKey("")).toBeNull();
  });

  it("signs a token request that Google can verify, valid for an hour", () => {
    const jwt = signedJwt(account, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(verified).toBe(true);
  });

  it("uploads one file into the folder and returns its ID", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return String(url).includes("oauth2")
        ? Response.json({ access_token: "token-123" })
        : Response.json({ id: "drive-file-abc" });
    }) as typeof fetch;

    const result = await uploadToDrive({
      account,
      folderId: "folder-xyz",
      name: "AA-7K3Q_Norbu-Tenzin_passport_2026-11-12.pdf",
      mime: "application/pdf",
      bytes: new Uint8Array(PDF),
      fetchImpl: fakeFetch,
    });
    expect(result).toEqual({ id: "drive-file-abc" });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const upload = calls[1]!;
    expect(upload.url).toContain("uploadType=multipart");
    expect(upload.url).toContain("supportsAllDrives=true");
    const headers = upload.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-123");
    expect(headers["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
    const body = (upload.init.body as Buffer).toString("latin1");
    expect(body).toContain('"parents":["folder-xyz"]');
    expect(body).toContain('"name":"AA-7K3Q_Norbu-Tenzin_passport_2026-11-12.pdf"');
    expect(body).toContain("Content-Type: application/pdf");
    expect(body).toContain("%PDF-1.7");
  });

  it("fails clearly when Google refuses, without leaking the response", async () => {
    const refuseToken = (async () => new Response("secret detail", { status: 401 })) as typeof fetch;
    await expect(
      uploadToDrive({ account, folderId: "f", name: "n", mime: "application/pdf", bytes: new Uint8Array(PDF), fetchImpl: refuseToken }),
    ).rejects.toMatchObject({ name: "DriveError", status: 401, message: "Google refused the service account" });

    const refuseUpload = (async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? Response.json({ access_token: "t" })
        : new Response("no access to folder", { status: 404 })) as typeof fetch;
    const error = await uploadToDrive({
      account,
      folderId: "f",
      name: "n",
      mime: "application/pdf",
      bytes: new Uint8Array(PDF),
      fetchImpl: refuseUpload,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveError);
    expect((error as DriveError).status).toBe(404);
    expect((error as DriveError).message).not.toContain("no access to folder");

    const noId = (async (url: string | URL | Request) =>
      String(url).includes("oauth2") ? Response.json({ access_token: "t" }) : Response.json({})) as typeof fetch;
    await expect(
      uploadToDrive({ account, folderId: "f", name: "n", mime: "application/pdf", bytes: new Uint8Array(PDF), fetchImpl: noId }),
    ).rejects.toThrow(/no file ID/);
  });

  it("links staff to the file in Drive", () => {
    expect(driveFileUrl("abc_123-XYZ")).toBe("https://drive.google.com/file/d/abc_123-XYZ/view");
  });
});
