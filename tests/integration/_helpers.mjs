/**
 * Shared helpers for the prod-gate integration suite.
 *
 * Each test file here exercises one capability of the browser service
 * against a deployed target (the Cloud Run tagged revision in CI, or
 * `http://localhost:8080` during local development). They talk to the
 * service over HTTP and exercise real marketplace round-trips — unlike
 * the per-adapter unit tests under `tests/*.test.mjs` which mock fetch.
 *
 * Required env:
 *   TARGET_URL          — base URL of the service (no trailing slash).
 *   INTERNAL_API_KEY    — value of the `internal-api-key` secret.
 *
 * Run locally:
 *   TARGET_URL=http://localhost:8080 \
 *   INTERNAL_API_KEY=... \
 *   BSC_USERNAME=... BSC_PASSWORD=... \
 *   SPORTLOTS_USERNAME=... SPORTLOTS_PASSWORD=... \
 *   npm run test:prod-gate
 */

import assert from "node:assert/strict";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. See tests/integration/_helpers.mjs for the full list.`,
    );
  }
  return v;
}

export const TARGET_URL = requireEnv("TARGET_URL").replace(/\/$/, "");
const INTERNAL_API_KEY = requireEnv("INTERNAL_API_KEY");

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "x-internal-key": INTERNAL_API_KEY,
  };
}

/**
 * Build a unique credential key for this probe run. `slug` identifies the
 * marketplace (`bsc`, `sportlots`), `GITHUB_SHA` provides uniqueness when
 * running in CI; falls back to a timestamp locally so concurrent dev runs
 * don't collide.
 *
 * Key format matches `src/services/secrets-manager.ts`'s
 * KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/ — the literal
 * "-credentials-" segment is required or PUT /credentials/:key returns
 * HTTP 400 "Invalid credential key format".
 */
export function probeKey(slug) {
  const sha = (process.env.GITHUB_SHA || String(Date.now())).slice(0, 7);
  return `${slug}-credentials-probe-${sha}`;
}

export async function putCredentials(key, { username, password }) {
  const res = await fetch(`${TARGET_URL}/credentials/${key}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  assert.equal(
    res.status,
    200,
    `PUT /credentials/${key} returned ${res.status}: ${text}`,
  );
}

/**
 * Best-effort cleanup — never throws. Called from `after()` hooks via
 * wrappers that ignore errors so a cleanup failure can't mask the real
 * test failure.
 */
export async function deleteCredentials(key) {
  try {
    await fetch(`${TARGET_URL}/credentials/${key}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch (err) {
    // Log but don't rethrow — the test's real signal is its own
    // assertion, and a cleanup failure just leaves a SHA-scoped Secret
    // Manager entry that will age out anyway.
    console.warn(`cleanup of ${key} failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * POST /login/{slug} with a key referencing credentials already stored
 * via putCredentials. Returns `{ status, body }`. Marketplace login
 * calls can take 20-30 seconds (Puppeteer cold start + real SL/BSC
 * round-trip); the default timeout reflects that.
 */
export async function postLogin(slug, key, { timeoutMs = 90_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${TARGET_URL}/login/${slug}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _rawText: text };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Assertion helper used by every marketplace login test — same shape
 * each time so adding a new marketplace is a one-line `assertLoginOk`
 * call plus credential envs.
 */
export function assertLoginOk({ status, body }) {
  assert.equal(
    status,
    200,
    `login returned HTTP ${status}: ${JSON.stringify(body)}`,
  );
  assert.equal(
    body.success,
    true,
    `login body did not indicate success: ${JSON.stringify(body)}`,
  );
}
