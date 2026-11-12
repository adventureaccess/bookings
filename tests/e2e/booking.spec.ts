import { expect, test, type Page } from "@playwright/test";
import {
  bookingState,
  createTestDeparture,
  removeTestDeparture,
  type TestDeparture,
} from "./fixtures";

/**
 * The traveler's path through the booking form, in a real browser, checked
 * against what ends up in the database.
 */

let departure: TestDeparture;

test.beforeEach(async () => {
  departure = await createTestDeparture(4);
});

test.afterEach(async () => {
  await removeTestDeparture(departure.id);
});

/**
 * Opens a page. The dev server can show an error overlay on the first page
 * after it starts (Netlify's local edge emulation failing to launch, which
 * has nothing to do with the app); clear it so it cannot cover the form.
 */
async function open(page: Page, path: string) {
  const response = await page.goto(path);
  await page.evaluate(() => document.querySelector("vite-error-overlay")?.remove());
  return response;
}

async function fillLead(page: Page) {
  await page.getByLabel("First name").first().fill("Tenzin");
  await page.getByLabel("Last name").first().fill("Norbu");
  await page.getByLabel("Email", { exact: true }).fill("Tenzin.Norbu@Example.com");
  await page.getByLabel("Phone").fill("+1 555 010 0100");
}

test("a party of two books and their seats are held", async ({ page }) => {
  await open(page, `${departure.path}&travelers=2`);
  await expect(page.locator("main h1")).toContainText("Ladakh");

  // The server worked out the money: 2 x $4,950.
  await expect(page.getByTestId("plan-total")).toHaveText("$9,900");
  await expect(page.getByText("Second payment")).toBeVisible();

  await fillLead(page);
  await page.locator("#t1_q1").fill("172 cm");
  await page.locator("#t2_first_name").fill("Pema");
  await page.locator("#t2_last_name").fill("Norbu");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Hold 2 seats" }).click();

  await expect(page).toHaveURL(/\/booking\/AA-[2-9A-HJ-NP-Z]{4}\?t=/);
  await expect(page.getByTestId("booking-heading")).toHaveText("Your seats are held.");
  await expect(page.getByTestId("hold-note")).toContainText("Thank you, Tenzin.");
  // The booking page never shows contact details.
  await expect(page.locator("main")).not.toContainText("example.com", { ignoreCase: true });

  const state = await bookingState(departure.id);
  expect(state.bookings).toHaveLength(1);
  expect(state.bookings[0]).toMatchObject({
    status: "pending",
    traveler_count: 2,
    total_cents: 990000,
  });
  expect(state.holds).toHaveLength(1);
  expect(state.holds[0]?.seats).toBe(2);
  expect(state.travelers).toHaveLength(2);
  expect(state.travelers[0]).toMatchObject({
    first_name: "Tenzin",
    email: "tenzin.norbu@example.com",
    is_lead: true,
    answers: { q1: "172 cm" },
  });
  expect(state.travelers[1]).toMatchObject({ first_name: "Pema", email: null, is_lead: false });
});

test("mistakes are explained per field, typed values stay, and nothing is held", async ({ page }) => {
  await open(page, departure.path);
  await page.getByLabel("First name").fill("Tenzin");
  await page.getByLabel("Email", { exact: true }).fill("not-an-email");
  await page.getByRole("button", { name: "Hold my seat" }).click();

  await expect(page.getByText("Some fields need attention. Nothing has been held yet.")).toBeVisible();
  await expect(page.getByText("Enter a last name.")).toBeVisible();
  await expect(page.getByText("That email address does not look right.")).toBeVisible();
  await expect(page.getByText("Enter a phone number.")).toBeVisible();
  await expect(page.getByText("Accept the terms to continue.")).toBeVisible();
  await expect(page.getByLabel("First name")).toHaveValue("Tenzin");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("not-an-email");

  const state = await bookingState(departure.id);
  expect(state.bookings).toHaveLength(0);
  expect(state.holds).toHaveLength(0);
});

test("going back and submitting again reuses the booking and its hold", async ({ page }) => {
  await open(page, `${departure.path}&travelers=2`);
  await fillLead(page);
  await page.locator("#t2_first_name").fill("Pema");
  await page.locator("#t2_last_name").fill("Norbu");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Hold 2 seats" }).click();
  await expect(page.getByTestId("booking-heading")).toBeVisible();
  const reference = await page.getByTestId("booking-reference").textContent();

  // Same browser, back to the form, this time for one traveler.
  await open(page, departure.path);
  await fillLead(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Hold my seat" }).click();

  await expect(page.getByTestId("booking-heading")).toHaveText("Your seat is held.");
  await expect(page.getByTestId("booking-reference")).toHaveText(reference ?? "");

  const state = await bookingState(departure.id);
  expect(state.bookings).toHaveLength(1);
  expect(state.holds).toHaveLength(1);
  expect(state.holds[0]?.seats).toBe(1);
  expect(state.travelers).toHaveLength(1);
});

test("the terms can be read before accepting", async ({ page }) => {
  await open(page, departure.path);
  const terms = page.locator("details", { hasText: "Read the" });
  await terms.locator("summary").click();
  await expect(terms.getByRole("heading").first()).toBeVisible();
});

test("a full departure cannot be booked, and a second visitor is told so", async ({ browser }) => {
  await removeTestDeparture(departure.id);
  departure = await createTestDeparture(1);

  const first = await browser.newContext();
  const pageOne = await first.newPage();
  await open(pageOne, departure.path);
  await fillLead(pageOne);
  await pageOne.getByRole("checkbox").check();

  // A second visitor loads the form while the seat is still free...
  const second = await browser.newContext();
  const pageTwo = await second.newPage();
  await open(pageTwo, departure.path);
  await fillLead(pageTwo);
  await pageTwo.getByRole("checkbox").check();

  // ...then the first one takes it.
  await pageOne.getByRole("button", { name: "Hold my seat" }).click();
  await expect(pageOne.getByTestId("booking-heading")).toHaveText("Your seat is held.");

  await pageTwo.getByRole("button", { name: "Hold my seat" }).click();
  await expect(pageTwo.getByText("This departure just filled up. No seats are left.")).toBeVisible();
  await expect(pageTwo.getByTestId("not-bookable")).toContainText("This departure is full.");

  const state = await bookingState(departure.id);
  expect(state.bookings).toHaveLength(1);
  expect(state.holds).toHaveLength(1);

  await first.close();
  await second.close();
});

test("a private departure is not found without its key, or with a wrong one", async ({ page }) => {
  const path = `/${departure.slug}/${departure.id}`;
  expect((await open(page, path))?.status()).toBe(404);
  await expect(page.locator("main h1")).toHaveText("Page not found.");
  expect((await open(page, `${path}?key=wrong-key`))?.status()).toBe(404);
});

test("a booking page needs both the reference and its token", async ({ page }) => {
  expect((await open(page, "/booking/AA-2222?t=" + "a".repeat(32)))?.status()).toBe(404);
  expect((await open(page, "/booking/AA-2222"))?.status()).toBe(404);
});
