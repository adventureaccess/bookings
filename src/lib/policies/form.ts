/** Reads and checks the policy version form. */

const MAX_TITLE = 200;
const MAX_BODY = 50_000;

export interface PolicyInput {
  title: string;
  body_md: string;
}

export type PolicyFormValues = { title: string; body_md: string };
export type PolicyFormErrors = Partial<Record<keyof PolicyFormValues, string>>;

export type PolicyFormResult =
  | { ok: true; data: PolicyInput }
  | { ok: false; errors: PolicyFormErrors; values: PolicyFormValues };

export function parsePolicyForm(form: FormData): PolicyFormResult {
  const rawTitle = form.get("title");
  const rawBody = form.get("body_md");
  const values: PolicyFormValues = {
    title: typeof rawTitle === "string" ? rawTitle.trim().slice(0, MAX_TITLE + 1) : "",
    // Normalize line endings so the stored text is the same from any browser.
    body_md:
      typeof rawBody === "string"
        ? rawBody.replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY + 1)
        : "",
  };
  const errors: PolicyFormErrors = {};

  if (values.title === "") errors.title = "Enter a title.";
  else if (values.title.length > MAX_TITLE) errors.title = `Keep the title under ${MAX_TITLE} characters.`;

  if (values.body_md === "") errors.body_md = "Enter the policy text.";
  else if (values.body_md.length > MAX_BODY) errors.body_md = "The policy text is too long.";

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return { ok: true, data: values };
}
