/**
 * Sends one plain-text email through Resend. Errors carry the HTTP status
 * only, never the response body or the recipient.
 */

export class EmailError extends Error {
  constructor(readonly status: number) {
    super(`Resend answered with status ${status}`);
    this.name = "EmailError";
  }
}

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Sending the same key twice sends one email. The job's ID. */
  idempotencyKey: string;
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>;

export function createResendSender(apiKey: string, fetchImpl: typeof fetch = fetch): SendEmail {
  return async (email) => {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": email.idempotencyKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new EmailError(response.status);
  };
}
