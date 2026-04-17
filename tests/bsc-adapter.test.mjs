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
 *       - Invalid → clear token in SecretsManager, fall through to page-based login
 *   2b. If cached=false: need a page; throw if page is absent
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Module-level stubs (set up once before tests run)
// ---------------------------------------------------------------------------

// Puppeteer stub — avoid launching Chromium
const mockPage = {
  goto: async () => {},
  setViewport: async () => {},
  waitForSelector: async () => {},
  locator: () => ({ click: async () => {}, filter: () => ({ click: async () => {} }), setTimeout: () => ({ click: async () => {} }) }),
  type: async () => {},
  evaluate: async () => undefined,
  waitForFunction: async () => {},
  $: async () => null,
};

const mockBrowser = {
  newPage: async () => mockPage,
  close: async () => {},
};

function patchPuppeteer() {
  const puppeteerPath = require.resolve("puppeteer");
  require.cache[puppeteerPath] = {
    id: puppeteerPath,
    filename: puppeteerPath,
    loaded: true,
    exports: {
      default: { launch: async () => mockBrowser },
      launch: async () => mockBrowser,
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

describe("BSCAdapter.login", () => {
  it("should return success with storeName when cached token passes profile validation", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "Bearer abc123",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: null,
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
  });

  it("should clear the stale token when the BSC profile API rejects the cached token", async () => {
    const updatedCredentials = [];

    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "Bearer stale-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updatedCredentials.push({ key, creds }),
    });

    // Profile call returns 401 (invalid token), then the fallback page-based path
    // throws because there is no Puppeteer page (page=undefined passed to constructor).
    const restore = stubFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    }));

    const adapter = new BSCAdapter(undefined);
    // The adapter will clear the token, then attempt to use result.page.
    // Since loginWithBrowser now returns { cached: false, page: mockPage } after
    // clearing, and mockPage has no working goto/locator calls that return real data,
    // the login will fail — but the important assertion is that the token was cleared.
    await adapter.login("bsc-credentials-seller1").catch(() => {});
    restore();

    assert.equal(updatedCredentials.length, 1, "should call updateCredentials exactly once to clear the token");
    const [update] = updatedCredentials;
    assert.equal(update.key, "bsc-credentials-seller1");
    assert.equal(update.creds.token, undefined, "token should be cleared");
    assert.equal(update.creds.expiresAt, undefined, "expiresAt should be cleared");
    assert.equal(update.creds.username, "seller@example.com", "username should be preserved");
  });

  it("should throw when loginWithBrowser returns no page and no token", async () => {
    // Simulate a scenario where credentials have no token AND no page is supplied.
    // loginWithBrowser returns { cached: false, page: mockPage } from puppeteer stub,
    // then the browser-based login path runs on the mockPage. Since mockPage.goto
    // doesn't throw but the locator chain for 'Sign In' fails silently, eventually
    // the code throws 'Neither Sign In nor Sign Out button found'.
    // We verify the adapter returns a failure response (not a crash) — confirming
    // the error is caught and wrapped in the try/catch.

    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: undefined,
        expiresAt: undefined,
      },
      updateCredentials: null,
    });

    // Stub page with a locator that throws immediately (Sign In not found)
    const throwingPage = {
      ...mockPage,
      locator: () => ({
        filter: () => ({
          click: async () => { throw new Error("Button not found"); },
        }),
        click: async () => { throw new Error("Button not found"); },
        setTimeout: () => ({
          click: async () => { throw new Error("Button not found"); },
        }),
      }),
    };

    delete require.cache[require.resolve("../dist/adapters/base-adapter")];
    delete require.cache[require.resolve("../dist/adapters/bsc-adapter")];

    // Override puppeteer to return throwingPage
    const puppeteerPath = require.resolve("puppeteer");
    require.cache[puppeteerPath].exports = {
      default: { launch: async () => ({ newPage: async () => throwingPage, close: async () => {} }) },
      launch: async () => ({ newPage: async () => throwingPage, close: async () => {} }),
    };

    const smPath = require.resolve("../dist/services/secrets-manager");
    const smMod = require(smPath);
    smMod.SecretsManagerService = class {
      async getCredentials() {
        return { username: "seller@example.com", password: "secret" };
      }
      async updateCredentials() {}
    };

    const { BSCAdapter: FreshBSCAdapter } = require("../dist/adapters/bsc-adapter");
    const adapter = new FreshBSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-seller1");

    // Restore puppeteer stub to standard mockPage for subsequent tests
    require.cache[puppeteerPath].exports = {
      default: { launch: async () => mockBrowser },
      launch: async () => mockBrowser,
    };

    assert.equal(result.success, false, "should return failure when browser login fails");
    assert.ok(result.error, "should include an error message");
  });

  it("should include Authorization header in the profile validation request", async () => {
    const receivedHeaders = {};

    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "Bearer check-header-token",
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
      "Bearer check-header-token",
      "should send the cached token as the Authorization header"
    );
  });
});
