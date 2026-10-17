import fsp from "node:fs/promises";

export const STRIPE_KEY_VAR = "STRIPE_SECRET_KEY";

const STRIPE_API = "https://api.stripe.com/v1/charges";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

function tzOffsetMs(timeZone, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function startOfDayEpoch(timeZone, date = new Date()) {
  const offset = tzOffsetMs(timeZone, date);
  const local = new Date(date.getTime() + offset);
  const midnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  return Math.floor((midnight - offset) / 1000);
}

function isSale(charge) {
  if (!charge || charge.paid !== true) return false;
  if (charge.status && charge.status !== "succeeded") return false;
  return charge.refunded !== true;
}

function net(charge) {
  const amount = Number(charge.amount) || 0;
  const refunded = Number(charge.amount_refunded) || 0;
  return Math.max(0, amount - refunded);
}

export function aggregate(charges, { timeZone, now = new Date() } = {}) {
  const dayStart = startOfDayEpoch(timeZone ?? "UTC", now);
  const sales = (charges ?? []).filter(isSale);
  const today = sales.filter((charge) => Number(charge.created) >= dayStart);
  const latest = sales.reduce(
    (best, charge) =>
      !best || Number(charge.created) > Number(best.created) ? charge : best,
    null,
  );
  const currency = (latest?.currency ?? sales[0]?.currency ?? "cad")
    .toString()
    .toUpperCase();

  return {
    count: sales.length,
    amountMinor: sales.reduce((sum, charge) => sum + net(charge), 0),
    todayCount: today.length,
    todayAmountMinor: today.reduce((sum, charge) => sum + net(charge), 0),
    currency,
    latestId: latest?.id ?? null,
    latestAt: latest ? new Date(Number(latest.created) * 1000).toISOString() : null,
    dayStart,
  };
}

export async function fetchStripeCharges(
  secretKey,
  { fetchImpl = fetch, maxPages = MAX_PAGES, createdGte } = {},
) {
  const charges = [];
  let startingAfter = null;

  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (startingAfter) query.set("starting_after", startingAfter);
    if (createdGte) query.set("created[gte]", String(createdGte));

    const response = await fetchImpl(`${STRIPE_API}?${query}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": "2024-06-20",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`Stripe charges request failed: ${detail}`);
    }

    const data = Array.isArray(body.data) ? body.data : [];
    charges.push(...data);
    if (!body.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }

  return charges;
}

export function normalizePlaceholder(parsed, now = new Date()) {
  const charges = Array.isArray(parsed?.charges) ? parsed.charges : [];
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return charges.map((charge) => ({
    paid: true,
    ...charge,
    created:
      charge.created ??
      nowSeconds - Math.round(Number(charge.minutesAgo ?? 0) * 60),
  }));
}

export async function readPlaceholder(file, now = new Date()) {
  const raw = await fsp.readFile(file, "utf8");
  return normalizePlaceholder(JSON.parse(raw), now);
}

export async function loadSales({
  secretKey,
  placeholderFile,
  timeZone = "UTC",
  now = new Date(),
  fetchImpl = fetch,
}) {
  if (secretKey) {
    const charges = await fetchStripeCharges(secretKey, { fetchImpl });
    return { ...aggregate(charges, { timeZone, now }), source: "stripe" };
  }

  const charges = await readPlaceholder(placeholderFile, now);
  return {
    ...aggregate(charges, { timeZone, now }),
    source: "placeholder",
    missingEnv: STRIPE_KEY_VAR,
  };
}
