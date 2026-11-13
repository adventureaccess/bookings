/**
 * A small HubSpot CRM client: only the calls the booking sync needs. No SDK.
 * Errors carry the HTTP status and HubSpot's error category, never the
 * response body, which can echo back names and email addresses.
 */

const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  constructor(
    readonly status: number,
    readonly category: string | null,
    what: string,
  ) {
    super(`HubSpot ${what} failed with status ${status}${category ? ` (${category})` : ""}`);
    this.name = "HubSpotError";
  }
}

type Fetch = typeof fetch;
type Properties = Record<string, string>;

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: { id: string; label: string }[];
}

export interface HubSpotClient {
  /** The internal names of every deal property that exists in the portal. */
  dealPropertyNames(): Promise<Set<string>>;
  dealPipelines(): Promise<HubSpotPipeline[]>;
  findContactByEmail(email: string): Promise<HubSpotContact | null>;
  createContact(properties: Properties): Promise<string>;
  updateContact(id: string, properties: Properties): Promise<void>;
  createDeal(properties: Properties): Promise<string>;
  /** Returns false when the deal no longer exists. */
  updateDeal(id: string, properties: Properties): Promise<boolean>;
  associateDealWithContact(dealId: string, contactId: string): Promise<void>;
}

export function createHubSpotClient(token: string, fetchImpl: Fetch = fetch): HubSpotClient {
  async function call(method: string, path: string, what: string, body?: unknown): Promise<Response> {
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok || response.status === 404 ? response : fail(response, what);
  }

  async function fail(response: Response, what: string): Promise<never> {
    let category: string | null = null;
    try {
      const parsed = (await response.json()) as { category?: unknown };
      if (typeof parsed.category === "string") category = parsed.category.slice(0, 60);
    } catch {
      // no readable body; the status is enough
    }
    throw new HubSpotError(response.status, category, what);
  }

  async function json<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    const response = await call(method, path, what, body);
    if (response.status === 404) await fail(response, what);
    return (await response.json()) as T;
  }

  return {
    async dealPropertyNames() {
      const data = await json<{ results: { name: string }[] }>(
        "GET",
        "/crm/v3/properties/deals",
        "reading deal properties",
      );
      return new Set(data.results.map((property) => property.name));
    },

    async dealPipelines() {
      const data = await json<{ results: HubSpotPipeline[] }>(
        "GET",
        "/crm/v3/pipelines/deals",
        "reading deal pipelines",
      );
      return data.results.map((pipeline) => ({
        id: pipeline.id,
        label: pipeline.label,
        stages: pipeline.stages.map((stage) => ({ id: stage.id, label: stage.label })),
      }));
    },

    async findContactByEmail(email) {
      const data = await json<{ results: HubSpotContact[] }>(
        "POST",
        "/crm/v3/objects/contacts/search",
        "finding a contact",
        {
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
          properties: ["email", "firstname", "lastname", "phone"],
          limit: 1,
        },
      );
      return data.results[0] ?? null;
    },

    async createContact(properties) {
      const data = await json<{ id: string }>("POST", "/crm/v3/objects/contacts", "creating a contact", {
        properties,
      });
      return data.id;
    },

    async updateContact(id, properties) {
      await json("PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, "updating a contact", {
        properties,
      });
    },

    async createDeal(properties) {
      const data = await json<{ id: string }>("POST", "/crm/v3/objects/deals", "creating a deal", {
        properties,
      });
      return data.id;
    },

    async updateDeal(id, properties) {
      const response = await call(
        "PATCH",
        `/crm/v3/objects/deals/${encodeURIComponent(id)}`,
        "updating a deal",
        { properties },
      );
      return response.status !== 404;
    },

    async associateDealWithContact(dealId, contactId) {
      await json(
        "PUT",
        `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/contacts/${encodeURIComponent(contactId)}`,
        "linking a deal and a contact",
      );
    },
  };
}
