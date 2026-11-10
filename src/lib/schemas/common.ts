import { z } from "zod";

/**
 * Shared building blocks for form and API schemas. Every string has a length
 * cap. Feature schemas (booking form, departure form) arrive with their
 * milestones and build on these.
 */

export const uuid = z.uuid();

export const cents = z.number().int().nonnegative().max(100_000_000);

export const slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const personName = z.string().trim().min(1).max(80);

export const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());

export const phone = z.string().trim().min(5).max(32);

/** Booking references look like AA-7K3Q. No 0, O, 1 or I. */
export const bookingReference = z
  .string()
  .regex(/^AA-[2-9A-HJ-NP-Z]{4,8}$/);
