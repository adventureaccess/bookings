import type { AstroCookies } from "astro";
import { bookingReference } from "../schemas";
import { isAccessToken } from "./token";

/**
 * Remembers the traveler's pending booking in their browser, so that going
 * back and submitting the form again changes that booking and reuses its
 * hold. The cookie holds the reference and access token; script on the page
 * cannot read it.
 */

const COOKIE = "aa_booking";
const MAX_AGE_SECONDS = 2 * 60 * 60;

export interface BookingPointer {
  reference: string;
  token: string;
}

export function rememberBooking(cookies: AstroCookies, pointer: BookingPointer): void {
  cookies.set(COOKIE, `${pointer.reference}.${pointer.token}`, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function recallBooking(cookies: AstroCookies): BookingPointer | null {
  const raw = cookies.get(COOKIE)?.value ?? "";
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const reference = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (!bookingReference.safeParse(reference).success || !isAccessToken(token)) return null;
  return { reference, token };
}
