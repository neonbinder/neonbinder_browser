/**
 * Unit tests for SportlotsAdapter.login retry loop.
 *
 * Strategy: patch SecretsManagerService and the global fetch before loading
 * the adapter from compiled CJS dist, mirroring bsc-adapter.test.mjs.
 *
 * The retry loop:
 *   - Up to 5 attempts total (initial + 4 retries)
 *   - Retries on: 429, 5xx, "no cookies parsed", network throw
 *   - Does NOT retry on: 4xx non-429, validation-sees-login-page,
 *     invalid-credentials-format
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Short-circuit setTimeout so the test suite doesn't actually sleep
// ~7.5s per "give up after 5 attempts" test. jitter math still runs.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

function loadSportlotsAdapter({ credentials = null, updateCredentials = null } = {}) {
  delete require.cache[require.resolve("../dist/adapters/base-adapter")];
  delete require.cache[require.resolve("../dist/adapters/sportlots-adapter")];

  const smPath = require.resolve("../dist/services/secrets-manager");
  const smMod = require(smPath);
  smMod.SecretsManagerService = class MockSecretsManagerService {
    async getCredentials(_key) {
      return credentials ?? { username: "user@example.com", password: "pw" };
    }
    async updateCredentials(key, creds) {
      if (updateCredentials) updateCredentials(key, creds);
    }
    async deleteCredentials(_key) {}
    async credentialsExist(_key) { return true; }
  };

  const { SportlotsAdapter } = require("../dist/adapters/sportlots-adapter");
  return SportlotsAdapter;
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

// SportLots returns cookies inline in JS. A single-cookie body that our
// regex /document\.cookie\s*=\s*"([^"]+)"/g matches.
const OK_LOGIN_BODY = `<html><body><script>document.cookie = "sl_session=abc123; path=/";</script></body></html>`;
// Validation fetch: body must NOT contain "login.tpl" or "signin.tpl".
const OK_VALIDATE_BODY = `<html>dashboard</html>`;

function response({ status = 200, body = "" }) {
  return { status, text: async () => body };
}

/**
 * Build a fetch stub that returns different responses for the login POST
 * and validation GET, tracking how many login calls were made.
 */
function scriptedLoginFetch(loginResponses, validateResponse = response({ body: OK_VALIDATE_BODY })) {
  let loginCalls = 0;
  const stub = async (url, _opts) => {
    const u = String(url);
    if (u.includes("/cust/custbin/signin.tpl")) {
      const r = loginResponses[loginCalls] ?? loginResponses[loginResponses.length - 1];
      loginCalls++;
      if (r instanceof Error) throw r;
      return r;
    }
    if (u.includes("/inven/dealbin/newinven.tpl")) {
      return validateResponse;
    }
    throw new Error(`unexpected fetch url: ${u}`);
  };
  stub.loginCalls = () => loginCalls;
  return stub;
}

describe("SportlotsAdapter.login retry loop", () => {
  it("retries on transient 500 then succeeds", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      response({ status: 500 }),
      response({ status: 500 }),
      response({ status: 200, body: OK_LOGIN_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed after retries");
      assert.equal(stub.loginCalls(), 3, "should have made exactly 3 login attempts");
    } finally {
      restore();
    }
  });

  it("does NOT retry on 400 non-429 (treated as permanent)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 400 })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false, "should fail");
      assert.equal(stub.loginCalls(), 1, "should give up after first attempt (400 is not retryable)");
      assert.match(result.error, /HTTP 400/);
    } finally {
      restore();
    }
  });

  it("gives up after 5 attempts when 500 is persistent", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 500 })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false, "should fail");
      assert.equal(stub.loginCalls(), 5, "should exhaust all 5 attempts");
      assert.match(result.error, /SportLots is unavailable/);
    } finally {
      restore();
    }
  });

  it("retries on fetch throw then succeeds", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      response({ status: 200, body: OK_LOGIN_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed after network-error retries");
      assert.equal(stub.loginCalls(), 3, "should have made exactly 3 login attempts");
    } finally {
      restore();
    }
  });

  it("retries on empty body (no cookies parsed)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      response({ status: 200, body: "<html>nothing</html>" }),
      response({ status: 200, body: OK_LOGIN_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed after empty-body retry");
      assert.equal(stub.loginCalls(), 2);
    } finally {
      restore();
    }
  });

  it("does NOT retry when validation sees login page (bad credentials)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch(
      [response({ status: 200, body: OK_LOGIN_BODY })],
      response({ status: 200, body: `<html>please visit login.tpl</html>` }),
    );
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(stub.loginCalls(), 1, "should give up after one attempt — validation failure is permanent");
      assert.match(result.error, /login validation failed/);
    } finally {
      restore();
    }
  });

  it("does NOT retry when credentials are missing", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "", password: "" },
    });
    // No fetch should happen; use a stub that would throw if called.
    const restore = stubFetch(async () => {
      throw new Error("fetch should not be called when credentials are missing");
    });
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.match(result.error, /Invalid credentials format/);
    } finally {
      restore();
    }
  });
});
