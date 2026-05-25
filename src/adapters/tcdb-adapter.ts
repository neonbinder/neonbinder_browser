import puppeteer, { Browser, Page } from "puppeteer";

/**
 * TCDB.com (Trading Card Database) adapter.
 *
 * NEO-24 Stage 3a: TCDB is the canonical fallback source of set-level
 * metadata (release date, total card count, block/series) when BSC and
 * SportLots responses come back thin. TCDB is gated behind Cloudflare's
 * "JavaScript required" interstitial — plain HTTP fetch returns a
 * challenge page, so we render via Puppeteer.
 *
 * Security: TCDB is a fully public site. No credentials are sent or
 * stored. No request/response field is logged that could contain user
 * data — TCDB enrichment is set-level catalog metadata only.
 */

export interface TcdbSetSearchResult {
  tcdbSetId: string;
  name: string;
  year: number;
  sport: string;
  url: string;
  /** 0.0–1.0 confidence vs the input setName. */
  score: number;
}

export interface TcdbSetMetadata {
  tcdbSetId: string;
  name: string;
  /** ISO-8601 date (YYYY-MM-DD) when known. */
  releaseDate?: string;
  totalCardCount?: number;
  /** Top-level block / series the set belongs to (e.g. "Topps Series 1 Base"). */
  block?: string;
  /** Permalink to the TCDB checklist page used to derive this metadata. */
  sourceUrl: string;
  /**
   * Free-form key/value pairs scraped from the set info table on the
   * checklist page. Keys are normalized to camelCase. Useful for feeding
   * the `selectorOptions.features` map without prescribing a schema.
   */
  additionalFeatures?: Record<string, string>;
}

export interface TcdbSearchQuery {
  sport: string;
  year: number;
  setName: string;
}

const TCDB_ORIGIN = "https://www.tcdb.com";
const NAV_TIMEOUT_MS = 30_000;
const MIN_SCORE = 0.7;

/**
 * Score threshold below which we drop a candidate. Public for testing.
 */
export const TCDB_MIN_SCORE = MIN_SCORE;

// --- string similarity (Jaro-Winkler) ---------------------------------------
// Lightweight, deps-free Jaro-Winkler implementation. Returns 0..1.

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatches = new Array<boolean>(la).fill(false);
  const bMatches = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;
  return (
    (matches / la + matches / lb + (matches - transpositions) / matches) / 3
  );
}

export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(a.length, b.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreMatch(input: string, candidate: string): number {
  const a = normalize(input);
  const b = normalize(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Slug-style exact match: drop spaces too.
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return 1;
  return jaroWinkler(a, b);
}

// --- Puppeteer browser handling ---------------------------------------------

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
  });
}

async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // A realistic UA helps with Cloudflare's lightweight checks.
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });
  return page;
}

/**
 * Treat unrecognized output as a Cloudflare interstitial. We bail early so the
 * caller can return `{ matches: [], reason: "tcdb-unavailable" }` rather than
 * surface a misleading parse error.
 */
function looksLikeChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("just a moment") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("attention required") ||
    lower.includes("cf-chl-bypass")
  );
}

class TcdbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcdbUnavailableError";
  }
}

// --- DOM extraction (runs inside Puppeteer page.evaluate) ------------------

type RawSearchResult = {
  href: string;
  name: string;
  year: number | null;
  sport: string;
};

/**
 * Extract candidate checklist links from a TCDB search results page. We look
 * for links whose href matches `/Checklist.cfm/sid/<digits>` (the canonical
 * set-detail URL). The surrounding row's first text node typically holds the
 * set name; we collect siblings to capture year/sport when present.
 */
async function extractSearchResults(page: Page): Promise<RawSearchResult[]> {
  return page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href*='Checklist.cfm/sid/']"),
    );
    const out: Array<{
      href: string;
      name: string;
      year: number | null;
      sport: string;
    }> = [];
    const seen = new Set<string>();
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/Checklist\.cfm\/sid\/(\d+)/i);
      if (!match) continue;
      const sid = match[1];
      if (seen.has(sid)) continue;
      seen.add(sid);
      const name = (a.textContent || "").trim();
      if (!name) continue;
      const row = a.closest("tr, li, div") as HTMLElement | null;
      const rowText = row ? row.textContent || "" : "";
      const yearMatch = rowText.match(/(?:^|\s)(19|20)\d{2}(?:\s|$|-)/);
      const sport = (() => {
        const sportMatches = rowText.match(
          /(Baseball|Basketball|Football|Hockey|Soccer|Boxing|MMA|Racing|Wrestling|Multi-Sport|Non-Sport)/i,
        );
        return sportMatches ? sportMatches[1] : "";
      })();
      out.push({
        href,
        name,
        year: yearMatch ? Number(yearMatch[0].trim()) : null,
        sport,
      });
    }
    return out;
  });
}

type RawSetMetadata = {
  name: string;
  releaseDate: string | null;
  totalCardCount: number | null;
  block: string | null;
  rawPairs: Array<{ label: string; value: string }>;
};

/**
 * Extract set-level metadata from a TCDB checklist page. TCDB renders the
 * set info as a key/value table near the top — labels like "Released",
 * "Card Count", "Set Type", etc. We grab the whole table for flexibility
 * and bubble named fields up to first-class properties.
 */
async function extractSetMetadata(page: Page): Promise<RawSetMetadata> {
  return page.evaluate(() => {
    const trim = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
    const titleEl =
      document.querySelector("h1") ||
      document.querySelector(".setName") ||
      document.querySelector("[itemprop='name']");
    const name = trim(titleEl?.textContent);

    const pairs: Array<{ label: string; value: string }> = [];
    // TCDB tends to use a definition list or a 2-column table. Try both.
    const dts = Array.from(document.querySelectorAll("dt"));
    for (const dt of dts) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName.toLowerCase() === "dd") {
        pairs.push({
          label: trim(dt.textContent),
          value: trim(dd.textContent),
        });
      }
    }
    const rows = Array.from(document.querySelectorAll("table tr"));
    for (const row of rows) {
      const cells = row.querySelectorAll("td, th");
      if (cells.length === 2) {
        pairs.push({
          label: trim(cells[0].textContent),
          value: trim(cells[1].textContent),
        });
      }
    }

    let releaseDate: string | null = null;
    let totalCardCount: number | null = null;
    let block: string | null = null;

    for (const { label, value } of pairs) {
      const llabel = label.toLowerCase();
      if (!releaseDate && /release|released|date/.test(llabel)) {
        // ISO-style first; otherwise leave the raw value and let server normalize.
        const isoMatch = value.match(/\d{4}-\d{2}-\d{2}/);
        if (isoMatch) {
          releaseDate = isoMatch[0];
        } else {
          const parsed = Date.parse(value);
          if (!Number.isNaN(parsed)) {
            releaseDate = new Date(parsed).toISOString().slice(0, 10);
          }
        }
      }
      if (
        totalCardCount === null &&
        /card\s*count|total\s*cards|number\s*of\s*cards|cards\s*in\s*set/.test(llabel)
      ) {
        const numMatch = value.match(/\d{1,5}/);
        if (numMatch) totalCardCount = Number(numMatch[0]);
      }
      if (!block && /block|series|parent/.test(llabel)) {
        block = value || null;
      }
    }

    return { name, releaseDate, totalCardCount, block, rawPairs: pairs };
  });
}

// --- Public API -------------------------------------------------------------

/**
 * Search TCDB for sets matching a sport/year/setName triple.
 *
 * Returns candidates with score ≥ 0.7 (Jaro-Winkler vs setName, with a
 * boost for slug-exact matches), ordered by score descending, capped at 10.
 *
 * Throws `TcdbUnavailableError` when TCDB returns a Cloudflare challenge
 * page. The route handler converts that into a soft response so the
 * Convex caller can degrade gracefully.
 */
export async function searchTcdbSets(
  query: TcdbSearchQuery,
): Promise<TcdbSetSearchResult[]> {
  const browser = await launchBrowser();
  try {
    const page = await newPage(browser);
    const queryString = `${query.year} ${query.setName} ${query.sport}`.trim();
    const url = `${TCDB_ORIGIN}/Search.cfm?Type=Sets&Keywords=${encodeURIComponent(
      queryString,
    )}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Give Cloudflare a beat to resolve a JS-challenge if one's interposed.
    await new Promise((r) => setTimeout(r, 1500));

    const html = await page.content();
    if (looksLikeChallenge(html)) {
      throw new TcdbUnavailableError("TCDB returned a Cloudflare challenge");
    }

    const raw = await extractSearchResults(page);
    const scored: TcdbSetSearchResult[] = [];
    for (const r of raw) {
      // If a year was passed in and the row's year disagrees, dampen the score.
      let score = scoreMatch(query.setName, r.name);
      if (query.year && r.year && r.year !== query.year) {
        score *= 0.85;
      }
      if (score < MIN_SCORE) continue;
      const sidMatch = r.href.match(/Checklist\.cfm\/sid\/(\d+)/i);
      if (!sidMatch) continue;
      const tcdbSetId = sidMatch[1];
      const absoluteUrl = r.href.startsWith("http")
        ? r.href
        : `${TCDB_ORIGIN}/${r.href.replace(/^\//, "")}`;
      scored.push({
        tcdbSetId,
        name: r.name,
        year: r.year ?? query.year,
        sport: r.sport || query.sport,
        url: absoluteUrl,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10);
  } finally {
    await safeClose(browser);
  }
}

/**
 * Fetch detailed metadata for a TCDB set by SID. SID is the `tcdbSetId`
 * returned from `searchTcdbSets`.
 */
export async function getTcdbSetMetadata(
  tcdbSetId: string,
): Promise<TcdbSetMetadata> {
  if (!/^\d+$/.test(tcdbSetId)) {
    throw new Error("Invalid tcdbSetId: expected numeric SID");
  }
  const sourceUrl = `${TCDB_ORIGIN}/Checklist.cfm/sid/${tcdbSetId}`;
  const browser = await launchBrowser();
  try {
    const page = await newPage(browser);
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const html = await page.content();
    if (looksLikeChallenge(html)) {
      throw new TcdbUnavailableError("TCDB returned a Cloudflare challenge");
    }
    const raw = await extractSetMetadata(page);

    const additionalFeatures: Record<string, string> = {};
    for (const { label, value } of raw.rawPairs) {
      if (!label || !value) continue;
      const key = label
        .replace(/[^a-zA-Z0-9 ]+/g, "")
        .trim()
        .split(/\s+/)
        .map((w, i) =>
          i === 0
            ? w.toLowerCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
        )
        .join("");
      if (!key) continue;
      // Don't shadow the first-class fields.
      if (["released", "releaseDate", "cardCount", "totalCardCount"].includes(key)) {
        continue;
      }
      additionalFeatures[key] = value;
    }

    return {
      tcdbSetId,
      name: raw.name,
      releaseDate: raw.releaseDate ?? undefined,
      totalCardCount: raw.totalCardCount ?? undefined,
      block: raw.block ?? undefined,
      sourceUrl,
      additionalFeatures:
        Object.keys(additionalFeatures).length > 0 ? additionalFeatures : undefined,
    };
  } finally {
    await safeClose(browser);
  }
}

async function safeClose(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch (err) {
    console.error(
      "[TCDB Adapter] browser.close() failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}

/**
 * Single-attempt-retry wrapper for transient Puppeteer flakiness.
 * Exposed at module scope so route handlers can wrap calls uniformly.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TcdbUnavailableError) throw err;
    console.warn(
      `[TCDB Adapter] ${label} failed on first attempt, retrying:`,
      err instanceof Error ? err.message : String(err),
    );
    return fn();
  }
}

export { TcdbUnavailableError };
