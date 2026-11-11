import { maskEmail, type StaffSession } from "../auth/staff";
import type {
  Departure,
  DepartureWithTrip,
  PolicyVersion,
  Trip,
} from "../db-types";
import { newPrivateToken, type DepartureInput } from "../departures/form";
import type { PolicyInput } from "../policies/form";
import { createServiceClient } from "../supabase/service";
import { planTripSync, tripFeedSchema, type ExistingTrip } from "../trips/feed";

/**
 * Data access for the admin. Everything here uses the service-role client,
 * which bypasses row-level security, so callers MUST have checked the staff
 * role first (see requireStaff / requireWriter in src/actions).
 */

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[admin] ${where} failed`, { code: error?.code ?? "unknown" });
}

// --- Activity log ----------------------------------------------------------

export async function logActivity(
  staff: StaffSession,
  entity: string,
  entityId: string | null,
  action: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  // The actor is stored in full: the activity log is a staff-only record of
  // who did what. Server logs get the masked form.
  const { error } = await createServiceClient().from("activity_log").insert({
    actor: staff.email,
    entity,
    entity_id: entityId,
    action,
    data,
  });
  if (error) {
    console.error("[admin] activity log write failed", {
      code: error.code,
      actor: maskEmail(staff.email),
      entity,
      action,
    });
  }
}

// --- Trips -----------------------------------------------------------------

export async function listTrips(): Promise<Trip[]> {
  const { data, error } = await createServiceClient()
    .from("trips")
    .select("id, slug, title, destination, hero_image_url, active, updated_at")
    .order("title");
  if (error) logDbError("listTrips", error);
  return (data ?? []) as Trip[];
}

export interface TripSyncSummary {
  added: number;
  updated: number;
  unchanged: number;
  deactivated: number;
}

export async function syncTrips(
  feedUrl: string | undefined,
  staff: StaffSession,
): Promise<Result<TripSyncSummary>> {
  if (!feedUrl) {
    return fail(
      "The trip feed is not set up yet. Set TRIPS_FEED_URL once the website publishes trips.json.",
    );
  }

  let json: unknown;
  try {
    const response = await fetch(feedUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) return fail(`The trip feed answered with status ${response.status}.`);
    const text = await response.text();
    if (text.length > 1_000_000) return fail("The trip feed is larger than expected.");
    json = JSON.parse(text);
  } catch {
    return fail("The trip feed could not be read. Check the URL and try again.");
  }

  const parsed = tripFeedSchema.safeParse(json);
  if (!parsed.success) {
    return fail("The trip feed is not in the expected format. Nothing was changed.");
  }

  const db = createServiceClient();
  const { data: existing, error: readError } = await db
    .from("trips")
    .select("slug, title, destination, hero_image_url, active");
  if (readError) {
    logDbError("syncTrips read", readError);
    return fail("Could not read the current trips.");
  }

  const plan = planTripSync((existing ?? []) as ExistingTrip[], parsed.data.trips);

  if (plan.upserts.length > 0) {
    const { error } = await db.from("trips").upsert(plan.upserts, { onConflict: "slug" });
    if (error) {
      logDbError("syncTrips upsert", error);
      return fail("Could not save the trips.");
    }
  }
  if (plan.deactivate.length > 0) {
    const { error } = await db
      .from("trips")
      .update({ active: false })
      .in("slug", plan.deactivate);
    if (error) {
      logDbError("syncTrips deactivate", error);
      return fail("Trips were saved, but switching off removed trips failed.");
    }
  }

  const summary: TripSyncSummary = {
    added: plan.added,
    updated: plan.updated,
    unchanged: plan.unchanged,
    deactivated: plan.deactivate.length,
  };
  await logActivity(staff, "trips", null, "sync", { ...summary });
  return { ok: true, value: summary };
}

// --- Departures ------------------------------------------------------------

const DEPARTURE_COLUMNS =
  "id, trip_id, start_date, end_date, price_cents, deposit_cents, currency, balance_due_date, min_travelers, max_travelers, status, visibility, private_token, policy_version_id, custom_questions, updated_at";

export async function listDepartures(): Promise<DepartureWithTrip[]> {
  const { data, error } = await createServiceClient()
    .from("departures")
    .select(`${DEPARTURE_COLUMNS}, trips ( title, slug )`)
    .order("start_date");
  if (error) logDbError("listDepartures", error);
  return (data ?? []) as unknown as DepartureWithTrip[];
}

export async function getDeparture(id: string): Promise<Departure | null> {
  const { data, error } = await createServiceClient()
    .from("departures")
    .select(DEPARTURE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) logDbError("getDeparture", error);
  return (data as Departure | null) ?? null;
}

/** A departure may only point at a policy that has been published. */
async function policyIsPublished(id: string): Promise<boolean> {
  const { data } = await createServiceClient()
    .from("policy_versions")
    .select("id")
    .eq("id", id)
    .not("published_at", "is", null)
    .maybeSingle();
  return Boolean(data);
}

function departureWriteMessage(code: string | undefined): string {
  if (code === "23503") return "That trip or policy no longer exists. Reload and try again.";
  if (code === "23514") return "Those values do not fit together. Check the dates and amounts.";
  return "Could not save the departure. Try again.";
}

export async function saveDeparture(
  id: string | null,
  input: DepartureInput,
  staff: StaffSession,
): Promise<Result<string>> {
  if (input.policy_version_id && !(await policyIsPublished(input.policy_version_id))) {
    return fail("Choose a published policy. Drafts cannot be attached to a departure.");
  }
  const db = createServiceClient();

  if (id === null) {
    const { data, error } = await db
      .from("departures")
      .insert({
        ...input,
        private_token: input.visibility === "private" ? newPrivateToken() : null,
      })
      .select("id")
      .single();
    if (error || !data) {
      logDbError("createDeparture", error);
      return fail(departureWriteMessage(error?.code));
    }
    await logActivity(staff, "departure", data.id, "create", {
      trip_id: input.trip_id,
      start_date: input.start_date,
      price_cents: input.price_cents,
      status: input.status,
    });
    return { ok: true, value: data.id };
  }

  const existing = await getDeparture(id);
  if (!existing) return fail("That departure no longer exists.");
  // Keep an existing private link working; only mint a token when one is needed.
  const privateToken =
    input.visibility === "private" ? (existing.private_token ?? newPrivateToken()) : null;

  const { error } = await db
    .from("departures")
    .update({ ...input, private_token: privateToken })
    .eq("id", id);
  if (error) {
    logDbError("updateDeparture", error);
    return fail(departureWriteMessage(error.code));
  }
  await logActivity(staff, "departure", id, "update", {
    price_cents: { from: existing.price_cents, to: input.price_cents },
    deposit_cents: { from: existing.deposit_cents, to: input.deposit_cents },
    max_travelers: { from: existing.max_travelers, to: input.max_travelers },
    status: { from: existing.status, to: input.status },
    visibility: { from: existing.visibility, to: input.visibility },
  });
  return { ok: true, value: id };
}

export async function deleteDeparture(
  id: string,
  staff: StaffSession,
): Promise<Result<null>> {
  const { error } = await createServiceClient().from("departures").delete().eq("id", id);
  if (error) {
    logDbError("deleteDeparture", error);
    return fail(
      error.code === "23503"
        ? "This departure has bookings, so it cannot be deleted. Set its status to canceled instead."
        : "Could not delete the departure.",
    );
  }
  await logActivity(staff, "departure", id, "delete");
  return { ok: true, value: null };
}

// --- Policy versions -------------------------------------------------------

const POLICY_COLUMNS = "id, title, body_md, version, published_at, updated_at";

export async function listPolicies(): Promise<PolicyVersion[]> {
  const { data, error } = await createServiceClient()
    .from("policy_versions")
    .select(POLICY_COLUMNS)
    .order("version", { ascending: false });
  if (error) logDbError("listPolicies", error);
  return (data ?? []) as PolicyVersion[];
}

export async function getPolicy(id: string): Promise<PolicyVersion | null> {
  const { data, error } = await createServiceClient()
    .from("policy_versions")
    .select(POLICY_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) logDbError("getPolicy", error);
  return (data as PolicyVersion | null) ?? null;
}

export async function savePolicy(
  id: string | null,
  input: PolicyInput,
  staff: StaffSession,
): Promise<Result<string>> {
  const db = createServiceClient();

  if (id === null) {
    const { data: latest } = await db
      .from("policy_versions")
      .select("version")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const version = (latest?.version ?? 0) + 1;
    const { data, error } = await db
      .from("policy_versions")
      .insert({ ...input, version })
      .select("id")
      .single();
    if (error || !data) {
      logDbError("createPolicy", error);
      return fail(
        error?.code === "23505"
          ? "Someone else just created that version. Reload and try again."
          : "Could not save the policy.",
      );
    }
    await logActivity(staff, "policy_version", data.id, "create", { version });
    return { ok: true, value: data.id };
  }

  // Only a draft can be edited. The database also blocks edits to a
  // published version; this filter gives a clearer message.
  const { data, error } = await db
    .from("policy_versions")
    .update(input)
    .eq("id", id)
    .is("published_at", null)
    .select("id");
  if (error) {
    logDbError("updatePolicy", error);
    return fail("Could not save the policy.");
  }
  if (!data || data.length === 0) {
    return fail("This version is published and can no longer be edited. Create a new version.");
  }
  await logActivity(staff, "policy_version", id, "update");
  return { ok: true, value: id };
}

export async function publishPolicy(
  id: string,
  staff: StaffSession,
): Promise<Result<null>> {
  const { data, error } = await createServiceClient()
    .from("policy_versions")
    .update({ published_at: new Date().toISOString() })
    .eq("id", id)
    .is("published_at", null)
    .select("id, version");
  if (error) {
    logDbError("publishPolicy", error);
    return fail("Could not publish the policy.");
  }
  if (!data || data.length === 0) return fail("This version is already published.");
  await logActivity(staff, "policy_version", id, "publish", { version: data[0]?.version });
  return { ok: true, value: null };
}
