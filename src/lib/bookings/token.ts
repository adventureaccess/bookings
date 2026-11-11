import { createHash, randomBytes } from "node:crypto";

/**
 * A traveler reaches their booking with its reference plus this token. Only
 * the token's hash is stored, so the database alone cannot open a booking.
 */

/** 32 URL-safe characters from 24 random bytes. */
export function newAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isAccessToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
