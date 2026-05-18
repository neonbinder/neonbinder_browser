import { describe, it } from "node:test";
import assert from "node:assert/strict";

// NEO-20: the browser service is now IAM-gated by Cloud Run. App-layer
// x-internal-key auth is gone. Authenticated requests carry a Google
// OIDC ID token whose audience equals the Cloud Run service URL. The
// caller is responsible for minting that token ahead of time, e.g.:
//
//   ID_TOKEN=$(gcloud auth print-identity-token \
//     --audiences="$SMOKE_TEST_URL" \
//     --impersonate-service-account=neonbinder-convex@<project>.iam.gserviceaccount.com)
//   SMOKE_TEST_URL=https://... SMOKE_TEST_ID_TOKEN=$ID_TOKEN npm run test:smoke
//
// Without auth, Cloud Run rejects the request before it reaches Express;
// the response is 403 (Forbidden), not 401, and the body is a Google
// error page rather than our JSON.

const BASE_URL = process.env.SMOKE_TEST_URL;
const ID_TOKEN = process.env.SMOKE_TEST_ID_TOKEN;

const MISSING_ENV = !BASE_URL || !ID_TOKEN;

if (MISSING_ENV) {
  console.warn(
    "Skipping smoke tests: SMOKE_TEST_URL and SMOKE_TEST_ID_TOKEN must be set"
  );
}

const maybeDescribe = MISSING_ENV ? describe.skip : describe;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${ID_TOKEN}`, ...extra };
}

maybeDescribe("Smoke tests", () => {
  it("GET /health returns 200 with status ok (public probe)", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.ok(
      ["dev", "prod"].includes(body.environment),
      `Expected environment to be dev or prod, got: ${body.environment}`
    );
  });

  it("GET /sites without auth is rejected by Cloud Run (403)", async () => {
    const res = await fetch(`${BASE_URL}/sites`);
    assert.equal(res.status, 403);
  });

  it("GET /sites with valid ID token returns 200", async () => {
    const res = await fetch(`${BASE_URL}/sites`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sites, "Response should have a sites object");
    assert.ok(body.sites.sportlots, "Sites should include sportlots");
    assert.ok(body.sites.bsc, "Sites should include bsc");
  });

  // --- Credential CRUD lifecycle ---

  const SMOKE_KEY = `smoketest-credentials-${Date.now()}`;

  it("PUT /credentials/:key stores credentials", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ username: "smoke_user", password: "smoke_pass" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  it("GET /credentials/:key/metadata returns stored metadata", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}/metadata`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, "smoke_user");
    assert.equal(body.hasToken, false);
  });

  it("DELETE /credentials/:key removes credentials", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
  });

  it("GET /credentials/:key/metadata returns 404 after deletion", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}/metadata`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 404);
  });

  it("PUT /credentials/:key rejects invalid key format", async () => {
    const res = await fetch(`${BASE_URL}/credentials/INVALID_KEY!!`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ username: "u", password: "p" }),
    });
    assert.equal(res.status, 400);
  });

  it("credential endpoints without auth are rejected by Cloud Run", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "u", password: "p" }),
    });
    assert.equal(res.status, 403);
  });

  // --- Security headers ---

  it("responses include security headers from helmet", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(
      res.headers.get("x-content-type-options"),
      "nosniff",
      "Missing or wrong x-content-type-options"
    );
    assert.ok(
      res.headers.has("x-frame-options"),
      "Missing x-frame-options header"
    );
    assert.ok(
      res.headers.has("strict-transport-security"),
      "Missing strict-transport-security header"
    );
    assert.ok(
      res.headers.has("content-security-policy"),
      "Missing content-security-policy header"
    );
  });
});
