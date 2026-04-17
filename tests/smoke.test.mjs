import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.SMOKE_TEST_URL;
const API_KEY = process.env.SMOKE_TEST_API_KEY;

const MISSING_ENV = !BASE_URL || !API_KEY;

if (MISSING_ENV) {
  console.warn(
    "Skipping smoke tests: SMOKE_TEST_URL and SMOKE_TEST_API_KEY must be set"
  );
}

const maybeDescribe = MISSING_ENV ? describe.skip : describe;

maybeDescribe("Smoke tests", () => {
  it("GET /health returns 200 with status ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.ok(
      ["dev", "prod"].includes(body.environment),
      `Expected environment to be dev or prod, got: ${body.environment}`
    );
  });

  it("GET /sites without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/sites`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  it("GET /sites with valid API key returns 200", async () => {
    const res = await fetch(`${BASE_URL}/sites`, {
      headers: { "x-internal-key": API_KEY },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sites, "Response should have a sites object");
    assert.ok(body.sites.sportlots, "Sites should include sportlots");
    assert.ok(body.sites.bsc, "Sites should include bsc");
  });

  it("GET /sites with wrong API key returns 401", async () => {
    const res = await fetch(`${BASE_URL}/sites`, {
      headers: { "x-internal-key": "wrong-key-value" },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  it("responses include rate limit headers", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.ok(
      res.headers.has("ratelimit-limit"),
      "Missing ratelimit-limit header"
    );
    assert.ok(
      res.headers.has("ratelimit-remaining"),
      "Missing ratelimit-remaining header"
    );
    assert.ok(
      res.headers.has("ratelimit-reset"),
      "Missing ratelimit-reset header"
    );
  });

  // --- Credential CRUD lifecycle ---

  const SMOKE_KEY = `smoketest-credentials-${Date.now()}`;

  it("PUT /credentials/:key stores credentials", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-internal-key": API_KEY },
      body: JSON.stringify({ username: "smoke_user", password: "smoke_pass" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  it("GET /credentials/:key/metadata returns stored metadata", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}/metadata`, {
      headers: { "x-internal-key": API_KEY },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, "smoke_user");
    assert.equal(body.hasToken, false);
  });

  it("DELETE /credentials/:key removes credentials", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}`, {
      method: "DELETE",
      headers: { "x-internal-key": API_KEY },
    });
    assert.equal(res.status, 200);
  });

  it("GET /credentials/:key/metadata returns 404 after deletion", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}/metadata`, {
      headers: { "x-internal-key": API_KEY },
    });
    assert.equal(res.status, 404);
  });

  it("PUT /credentials/:key rejects invalid key format", async () => {
    const res = await fetch(`${BASE_URL}/credentials/INVALID_KEY!!`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-internal-key": API_KEY },
      body: JSON.stringify({ username: "u", password: "p" }),
    });
    assert.equal(res.status, 400);
  });

  it("credential endpoints reject unauthenticated requests", async () => {
    const res = await fetch(`${BASE_URL}/credentials/${SMOKE_KEY}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "u", password: "p" }),
    });
    assert.equal(res.status, 401);
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
