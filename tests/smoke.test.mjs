import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.SMOKE_TEST_URL;
const API_KEY = process.env.SMOKE_TEST_API_KEY;

if (!BASE_URL || !API_KEY) {
  console.error(
    "Required env vars: SMOKE_TEST_URL and SMOKE_TEST_API_KEY must be set"
  );
  process.exit(1);
}

describe("Smoke tests", () => {
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
