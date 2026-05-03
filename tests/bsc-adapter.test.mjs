/**
 * Unit tests for BSCAdapter.login
 *
 * Strategy: patch SecretsManagerService and the global fetch before loading the adapter
 * from the compiled CJS dist. Puppeteer is also stubbed. Tests focus on the token-caching
 * path (which is the pure business logic) and the error branches that don't require
 * a real browser page interaction.
 *
 * The BSCAdapter.login flow:
 *   1. Call loginWithBrowser(key)
 *   2a. If cached=true: hit BSC profile API to validate the token
 *       - Valid   → return success with storeName
 *       - Invalid → clear token in SecretsManager, launchPage(), fall through
 *                   to the fresh Puppeteer login flow
 *   2b. If cached=false: a page is already launched by loginWithBrowser
 *
 * Token storage convention: Secret Manager stores the BSC token *without* the
 * "Bearer " prefix. The adapter (and the Convex adapter that calls the BSC
 * REST API) prepend "Bearer " on every request. Tests use bare tokens to
 * mirror production. See bsc-adapter.ts for why every prior cache-validation
 * silently 401-ed before this convention was made explicit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Module-level stubs (set up once before tests run)
// ---------------------------------------------------------------------------

// Default Puppeteer mock — drives the fresh-login flow to a successful end.
// Tests that need to fail an early step replace `locator` or `evaluate` per-test.
//
// The fresh-login flow needs:
//   1. goto(home)
//   2. locator('button').filter(...).click() — Sign In found
//   3. waitForSelector("#signInName")
//   4. type("#signInName", email) + type("#password", password)
//   5. locator('button:has-text("Next")').setTimeout(1000).click()
//   6. waitForFunction(...) — localStorage has a "Bearer"-containing value
//   7. evaluate(...) — returns a redux JSON string with `secret` field
//
// The redux blob's JSON serialization must contain both "secret" and "Bearer"
// substrings to satisfy the .filter() and .find() in the adapter, and the
// parsed `secret` field is what gets stored as the token (after .trim()).
function makeMockPage(overrides = {}) {
  const okClickable = {
    click: async () => {},
    setTimeout: () => ({ click: async () => {} }),
    filter: () => ({ click: async () => {} }),
  };
  return {
    goto: async () => {},
    setViewport: async () => {},
    waitForSelector: async () => {},
    locator: () => okClickable,
    type: async () => {},
    evaluate: async () => JSON.stringify({ secret: "Bearer fresh-extracted-token" }),
    waitForFunction: async () => {},
    $: async () => null,
    ...overrides,
  };
}

const defaultMockPage = makeMockPage();

const mockBrowser = {
  newPage: async () => defaultMockPage,
  close: async () => {},
};

function patchPuppeteer(launchImpl) {
  const puppeteerPath = require.resolve("puppeteer");
  const launch = launchImpl ?? (async () => mockBrowser);
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      default: { launch },
      launch,
    },
    children: [],
    parent: null,
    paths: [],
  };
}

patchPuppeteer();

// ---------------------------------------------------------------------------
// Per-test helpers
// ---------------------------------------------------------------------------

/**
 * Patch SecretsManagerService in the require cache, then reload bsc-adapter
 * and base-adapter fresh so they pick up the new mock.
 */
function loadBSCAdapter({ credentials, updateCredentials }) {
  // Clear cached modules so the adapter gets the freshly-patched SecretsManagerService
  delete require.cache[require.resolve("../dist/adapters/base-adapter")];
  delete require.cache[require.resolve("../dist/adapters/bsc-adapter")];

  const smPath = require.resolve("../dist/services/secrets-manager");
  const smMod = require(smPath);
  smMod.SecretsManagerService = class MockSecretsManagerService {
    async getCredentials(_key) {
      if (typeof credentials === "function") return credentials();
      return credentials;
    }
    async updateCredentials(key, creds) {
      if (updateCredentials) updateCredentials(key, creds);
    }
    async deleteCredentials(_key) {}
    async credentialsExist(_key) { return true; }
  };

  const { BSCAdapter } = require("../dist/adapters/bsc-adapter");
  return BSCAdapter;
}

/**
 * Install a global fetch stub for the duration of a single test.
 * Returns a restore function.
 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — cache-hit path", () => {
  it("returns success with storeName when cached token passes profile validation", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "bare-token-abc123",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const restore = stubFetch(async (url, _opts) => {
      assert.equal(new URL(url).hostname, "api-prod.buysportscards.com", "should hit BSC profile API");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sellerProfile: { sellerStoreName: "Acme Cards" },
        }),
      };
    });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    restore();

    assert.equal(result.success, true, "should succeed");
    assert.equal(result.storeName, "Acme Cards", "should include the store name from profile");
    assert.ok(result.expiresAt > Date.now(), "should return a future expiresAt");
    assert.match(result.message, /cached token/, "message should reference cached token");
    assert.equal(updates.length, 0, "must NOT mutate the secret on a clean cache hit");
  });

  it("sends the cached token with a 'Bearer ' prefix on the profile validation request (regression: bare-token 401)", async () => {
    const receivedHeaders = {};

    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        // Stored bare, no "Bearer " prefix — same as production extraction.
        token: "raw-jwt-token-value",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: null,
    });

    const restore = stubFetch(async (_url, opts) => {
      Object.assign(receivedHeaders, opts?.headers ?? {});
      return {
        ok: true,
        status: 200,
        json: async () => ({ sellerProfile: { sellerStoreName: "Test Store" } }),
      };
    });

    const adapter = new BSCAdapter(undefined);
    await adapter.login("bsc-credentials-seller1");
    restore();

    assert.equal(
      receivedHeaders["Authorization"],
      "Bearer raw-jwt-token-value",
      "must prepend 'Bearer ' to the bare cached token — historically every cache validation silently 401-ed without this prefix",
    );
  });
});

describe("BSCAdapter.login — cache-invalid → fresh-login path", () => {
  it("clears the stale token and runs a fresh Puppeteer login when validation 401s", async () => {
    const updatedCredentials = [];
    const baseCreds = {
      username: "seller@example.com",
      password: "secret",
      token: "stale-bare-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };

    // Default mockPage drives the fresh-login flow to success and persists
    // the extracted "Bearer fresh-extracted-token" via updateCredentials.
    // Patch BEFORE loadBSCAdapter so the adapter module captures this puppeteer.
    patchPuppeteer(async () => mockBrowser);

    const BSCAdapter = loadBSCAdapter({
      credentials: () => {
        // Initial getCredentials returns the cached creds; second call (after
        // clear) returns username/password only. Mirrors what real Secret
        // Manager would return after the clear-cache write.
        const callIdx = updatedCredentials.length;
        if (callIdx === 0) return baseCreds;
        return { username: baseCreds.username, password: baseCreds.password };
      },
      updateCredentials: (key, creds) => updatedCredentials.push({ key, creds }),
    });

    let profileCalls = 0;
    const restore = stubFetch(async () => {
      profileCalls++;
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: "Unauthorized" }),
      };
    });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    restore();

    assert.equal(profileCalls, 1, "should validate cached token exactly once");
    assert.equal(result.success, true, "fresh login should succeed after stale-cache clear");
    assert.match(result.message, /Successfully logged into/, "message should reflect fresh login, not cached");

    // First update: clearing the stale token. Second update: persisting the new token.
    assert.equal(updatedCredentials.length, 2, "should clear stale cache, then persist fresh token");
    const [clear, persist] = updatedCredentials;
    assert.equal(clear.creds.token, undefined, "stale-clear update should remove token");
    assert.equal(clear.creds.expiresAt, undefined, "stale-clear update should remove expiresAt");
    assert.equal(clear.creds.username, "seller@example.com", "stale-clear must preserve username");
    assert.equal(clear.creds.password, "secret", "stale-clear must preserve password");
    assert.equal(persist.creds.token, "Bearer fresh-extracted-token", "fresh login should persist the extracted token");
    assert.ok(persist.creds.expiresAt > Date.now(), "fresh login must set a future expiresAt");
  });

  it("returns a structured failure (not an unhandled throw) when Puppeteer launch fails after a 401", async () => {
    const updatedCredentials = [];

    // Patch puppeteer BEFORE loading the adapter. The adapter modules grab
    // their `puppeteer` reference at import time, so a later patchPuppeteer
    // would never reach base-adapter.launchPage().
    patchPuppeteer(async () => { throw new Error("Failed to launch Chromium"); });

    const BSCAdapter = loadBSCAdapter({
      credentials: () => {
        if (updatedCredentials.length === 0) {
          return {
            username: "seller@example.com",
            password: "secret",
            token: "stale-bare-token",
            expiresAt: Date.now() + 60 * 60 * 1000,
          };
        }
        return { username: "seller@example.com", password: "secret" };
      },
      updateCredentials: (key, creds) => updatedCredentials.push({ key, creds }),
    });

    const restore = stubFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    }));

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    restore();

    // Restore default puppeteer for subsequent tests.
    patchPuppeteer();

    assert.equal(result.success, false, "should return a structured failure");
    assert.ok(result.error, "should include an error message");
    assert.doesNotMatch(
      result.error,
      /No Puppeteer page available/,
      "must NOT surface the legacy 'No Puppeteer page available for BSC login' throw — that was the symptom of the pre-fix bug",
    );
    assert.match(
      result.error,
      /Failed to launch browser/,
      "should report a sanitized launch failure",
    );

    // The stale token must still have been cleared even though re-login failed —
    // otherwise we'd loop on the same dead token forever.
    assert.equal(updatedCredentials.length, 1, "should clear the stale cache before launch failed");
    assert.equal(updatedCredentials[0].creds.token, undefined);
    assert.equal(updatedCredentials[0].creds.expiresAt, undefined);
  });
});

describe("BSCAdapter.login — fresh-login path (no cached token)", () => {
  it("runs the Puppeteer flow and persists the extracted token + future expiresAt", async () => {
    const updatedCredentials = [];

    // Patch BEFORE loadBSCAdapter (see launch-failure test for why).
    patchPuppeteer(async () => mockBrowser);

    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        // No token / expiresAt — first-time login.
      },
      updateCredentials: (key, creds) => updatedCredentials.push({ key, creds }),
    });

    // No fetch should be hit on the fresh-login path; if the adapter calls
    // the profile API here it's a regression.
    const restore = stubFetch(async (url) => {
      throw new Error(`unexpected fetch on fresh-login path: ${url}`);
    });
    const beforeMs = Date.now();
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    const afterMs = Date.now();
    restore();

    assert.equal(result.success, true, "fresh login should succeed");
    assert.equal(updatedCredentials.length, 1, "should persist the extracted token exactly once");
    const persisted = updatedCredentials[0].creds;
    assert.equal(persisted.token, "Bearer fresh-extracted-token", "should persist what evaluate() returned");
    assert.ok(typeof persisted.expiresAt === "number", "expiresAt must be a number");
    const oneHourMs = 60 * 60 * 1000;
    assert.ok(
      persisted.expiresAt >= beforeMs + oneHourMs - 5000,
      `expiresAt should be ~1h in the future (got ${persisted.expiresAt - beforeMs}ms ahead of start)`,
    );
    assert.ok(
      persisted.expiresAt <= afterMs + oneHourMs + 5000,
      `expiresAt should be ~1h in the future (got ${persisted.expiresAt - afterMs}ms ahead of end)`,
    );
    assert.equal(result.expiresAt, persisted.expiresAt, "AdapterResponse.expiresAt should match what was persisted");
  });

  it("returns a failure when the Puppeteer flow can't find the Sign In button", async () => {
    // Stub a page where every locator click throws. The adapter should catch
    // the error and return a structured response, not crash.
    const throwingPage = makeMockPage({
      locator: () => ({
        filter: () => ({ click: async () => { throw new Error("Button not found"); } }),
        click: async () => { throw new Error("Button not found"); },
        setTimeout: () => ({ click: async () => { throw new Error("Button not found"); } }),
      }),
    });

    // Patch puppeteer BEFORE loading the adapter (see comment in the
    // launch-failure test for why ordering matters).
    patchPuppeteer(async () => ({
      newPage: async () => throwingPage,
      close: async () => {},
    }));

    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");

    // Restore default puppeteer for subsequent tests.
    patchPuppeteer();

    assert.equal(result.success, false, "should return failure when Sign In flow breaks");
    assert.ok(result.error, "should include an error message");
  });
});

// ---------------------------------------------------------------------------
// Cleanup invariant
// ---------------------------------------------------------------------------
//
// Every successful launchPage() must be paired with a cleanup() call so the
// underlying Chromium child process is killed. Without this, ~150-200 MiB
// leaks per request and Cloud Run OOM-kills the container after ~10 logins
// on the same instance. The 2026-05-03 dev-Cloud-Run OOM ("Memory limit of
// 2048 MiB exceeded with 2069 MiB used") was caused by this exact leak.
// These tests pin the invariant in code so a future refactor can't silently
// re-introduce the regression.

/**
 * Build an instrumented browser whose close() call is observable. Each test
 * passes its own counter object so it can assert how many times close was
 * invoked across the adapter's lifetime.
 */
function makeInstrumentedBrowser(counter, pageOverride) {
  return {
    newPage: async () => pageOverride ?? defaultMockPage,
    close: async () => {
      counter.calls++;
    },
  };
}

describe("BSCAdapter.cleanup — Chromium process lifecycle", () => {
  it("closes the launched browser exactly once after a successful fresh login", async () => {
    const counter = { calls: 0 };
    patchPuppeteer(async () => makeInstrumentedBrowser(counter));

    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();

    patchPuppeteer();

    assert.equal(result.success, true, "fresh login should succeed");
    assert.equal(counter.calls, 1, "browser.close() must run exactly once after a successful login");
  });

  it("still closes the launched browser when the login flow throws inside Puppeteer", async () => {
    const counter = { calls: 0 };
    // Page where every locator interaction throws — drives the adapter into
    // its catch block. The Browser was still launched, so cleanup must close
    // it; otherwise a single bad selector during a real flow leaks a
    // Chromium process.
    const throwingPage = makeMockPage({
      locator: () => ({
        filter: () => ({ click: async () => { throw new Error("Sign In not found"); } }),
        click: async () => { throw new Error("Sign In not found"); },
        setTimeout: () => ({ click: async () => { throw new Error("Sign In not found"); } }),
      }),
    });
    patchPuppeteer(async () => makeInstrumentedBrowser(counter, throwingPage));

    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();

    patchPuppeteer();

    assert.equal(result.success, false, "broken login should return a structured failure");
    assert.equal(counter.calls, 1, "browser.close() must still run when the login flow fails inside Puppeteer");
  });

  it("is a no-op on the cache-hit path — no browser was launched, so close() is never called", async () => {
    const counter = { calls: 0 };
    // Patch puppeteer with an instrumented browser; if the adapter ever
    // launches one on a cache hit, this counter will catch it.
    patchPuppeteer(async () => makeInstrumentedBrowser(counter));

    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "valid-cached-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: null,
    });

    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sellerProfile: { sellerStoreName: "Acme Cards" } }),
    }));

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    // cleanup() must be safe to call even though no browser was launched.
    await adapter.cleanup();
    restore();

    patchPuppeteer();

    assert.equal(result.success, true, "cache-hit path should succeed");
    assert.match(result.message, /cached token/, "should be the cached path, not fresh");
    assert.equal(counter.calls, 0, "no browser was launched, so cleanup must not invoke close()");
  });

  it("closes the freshly-launched browser on the cache-invalid → fresh-login fallthrough path", async () => {
    const counter = { calls: 0 };
    patchPuppeteer(async () => makeInstrumentedBrowser(counter));

    const updatedCredentials = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: () => {
        if (updatedCredentials.length === 0) {
          return {
            username: "seller@example.com",
            password: "secret",
            token: "stale-bare-token",
            expiresAt: Date.now() + 60 * 60 * 1000,
          };
        }
        return { username: "seller@example.com", password: "secret" };
      },
      updateCredentials: (key, creds) => updatedCredentials.push({ key, creds }),
    });

    // Profile-validation 401 → adapter clears the cache and falls through to
    // launchPage() inside login(). That launchPage() is the OOM-prone path
    // that the original bug never closed.
    const restore = stubFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    }));

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();
    restore();

    patchPuppeteer();

    assert.equal(result.success, true, "fallthrough fresh login should succeed");
    assert.equal(counter.calls, 1, "the freshly-launched browser on the fallthrough path must be closed");
  });

  it("is idempotent: calling cleanup() twice does not re-close the browser or throw", async () => {
    const counter = { calls: 0 };
    patchPuppeteer(async () => makeInstrumentedBrowser(counter));

    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });

    const adapter = new BSCAdapter(undefined);
    await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();
    await adapter.cleanup(); // second call must be a no-op

    patchPuppeteer();

    assert.equal(counter.calls, 1, "cleanup() must be idempotent — second call is a no-op");
  });

  it("swallows errors from browser.close() so cleanup-in-finally never masks the original error", async () => {
    // browser.close() throwing during cleanup is plausible if the Cloud Run
    // worker is being preempted. We must not let that bubble out of cleanup
    // and overwrite the real login result the route handler is about to
    // return to the caller.
    const counter = { calls: 0 };
    patchPuppeteer(async () => ({
      newPage: async () => defaultMockPage,
      close: async () => {
        counter.calls++;
        throw new Error("Browser already disconnected");
      },
    }));

    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });

    const adapter = new BSCAdapter(undefined);
    await adapter.login("bsc-credentials-seller1");

    // If cleanup re-throws, this assertion is what fails — it must not.
    await assert.doesNotReject(
      adapter.cleanup(),
      "cleanup() must catch errors from browser.close() so try/finally in route handlers never masks the real error",
    );

    patchPuppeteer();

    assert.equal(counter.calls, 1, "browser.close() should still have been attempted exactly once");
  });

  it("closes a separate browser per login when the same adapter instance is reused for multiple sequential logins", async () => {
    // Real route handlers create a new adapter per request, but defending
    // the invariant against accidental reuse is cheap and rules out a class
    // of leaks where a test or future refactor reuses an adapter without
    // realizing each login() launches a fresh browser.
    const counter = { calls: 0 };
    patchPuppeteer(async () => makeInstrumentedBrowser(counter));

    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });

    const adapter = new BSCAdapter(undefined);
    await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();
    await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();
    await adapter.login("bsc-credentials-seller1");
    await adapter.cleanup();

    patchPuppeteer();

    assert.equal(counter.calls, 3, "each sequential login on the same adapter must launch+close its own browser — no orphan processes");
  });
});
