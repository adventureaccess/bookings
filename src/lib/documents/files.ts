/**
 * Checking and naming uploaded files. The type is decided from the file's
 * first bytes, never from its name or what the browser claims.
 */

/**
 * The largest upload accepted. Netlify Functions take requests of about
 * 6 MB, and a file grows by a third in transit, so 4 MB is the real ceiling.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const DOCUMENT_KINDS = ["insurance", "passport"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const KIND_LABEL: Record<DocumentKind, string> = {
  insurance: "Proof of travel insurance",
  passport: "Passport copy",
};

export interface FileType {
  mime: "application/pdf" | "image/jpeg" | "image/png";
  extension: "pdf" | "jpg" | "png";
}

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/** PDF, JPEG or PNG by content, or null for anything else. */
export function sniffFileType(bytes: Uint8Array): FileType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mime: "application/pdf", extension: "pdf" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", extension: "jpg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: "png" };
  }
  return null;
}

export type UploadCheck =
  | { ok: true; bytes: Uint8Array; type: FileType }
  | { ok: false; message: string };

const megabytes = (bytes: number) => `${Math.floor(bytes / (1024 * 1024))} MB`;

/** Reads a form's file field and checks its size and type. */
export async function checkUpload(
  value: FormDataEntryValue | null,
  allowed: readonly FileType["mime"][] = ["application/pdf", "image/jpeg", "image/png"],
): Promise<UploadCheck> {
  if (!(value instanceof File) || value.size === 0) {
    return { ok: false, message: "Choose a file first." };
  }
  if (value.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `That file is larger than ${megabytes(MAX_UPLOAD_BYTES)}. Send a smaller scan or photo.`,
    };
  }
  const bytes = new Uint8Array(await value.arrayBuffer());
  const type = sniffFileType(bytes);
  if (!type || !allowed.includes(type.mime)) {
    return {
      ok: false,
      message:
        allowed.length === 1 ? "That file is not a PDF." : "Send a PDF, JPG or PNG. Other kinds of file are not accepted.",
    };
  }
  return { ok: true, bytes, type };
}

/** Letters and digits only, so the name is safe anywhere. Accents are dropped. */
function plain(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * The name a file gets in the Shared Drive, so staff can find it:
 * AA-7K3Q_Norbu-Tenzin_passport_2026-11-12.pdf
 */
export function documentFileName(input: {
  reference: string;
  firstName: string;
  lastName: string;
  kind: DocumentKind;
  extension: FileType["extension"];
  date: string;
}): string {
  const person = [plain(input.lastName), plain(input.firstName)].filter(Boolean).join("-") || "traveler";
  return `${input.reference}_${person}_${input.kind}_${input.date}.${input.extension}`;
}
