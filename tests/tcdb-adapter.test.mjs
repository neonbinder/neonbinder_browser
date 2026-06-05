/**
 * Unit tests for the TCDB adapter.
 *
 * We exercise:
 *   - the pure scoring helpers (jaroWinkler, scoreMatch, TCDB_MIN_SCORE)
 *   - the class façade: capability flags, getHomeUrl, and the public no-op
 *     login (these touch no network/Puppeteer).
 *   - the createAdapter factory returning a TcdbAdapter for "tcdb".
 *
 * Puppeteer-driven scraping paths (search/getSet) are NOT exercised here
 * because Cloudflare rendering is intractable to mock and fragile to stub;
 * they are covered by the deployed smoke tests. We deliberately never call
 * adapter.search()/getSet() in unit tests so no real Chromium launches.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tcdb = require("../dist/adapters/tcdb-adapter.js");
const { createAdapter } = require("../dist/adapters/index.js");

describe("TCDB adapter — scoreMatch", () => {
  it("returns 1.0 for exact normalized matches", () => {
    assert.equal(tcdb.scoreMatch("Topps Series 1", "Topps Series 1"), 1);
  });

  it("returns 1.0 for slug-equivalent matches (ignoring punctuation/case)", () => {
    assert.equal(
      tcdb.scoreMatch("Topps Series 1", "topps   series-1"),
      1,
    );
  });

  it("returns a moderate similarity for close variants", () => {
    const score = tcdb.scoreMatch(
      "Topps Chrome",
      "2024 Topps Chrome Baseball",
    );
    assert.ok(score > 0.7, `expected > 0.7, got ${score}`);
  });

  it("returns a low score for unrelated strings", () => {
    const score = tcdb.scoreMatch("Topps Chrome", "Donruss Optic");
    assert.ok(score < 0.7, `expected < 0.7, got ${score}`);
  });

  it("exports a minimum-score threshold of 0.7", () => {
    assert.equal(tcdb.TCDB_MIN_SCORE, 0.7);
  });
});

describe("TCDB adapter — jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    assert.equal(tcdb.jaroWinkler("abc", "abc"), 1);
  });

  it("returns 0 for empty inputs", () => {
    assert.equal(tcdb.jaroWinkler("", "abc"), 0);
    assert.equal(tcdb.jaroWinkler("abc", ""), 0);
  });

  it("returns a value in [0, 1]", () => {
    const v = tcdb.jaroWinkler("martha", "marhta");
    assert.ok(v > 0.9 && v <= 1, `expected high score, got ${v}`);
  });
});

describe("TcdbAdapter — class façade & capability flags", () => {
  it("getHomeUrl returns the TCDB origin", () => {
    const adapter = new tcdb.TcdbAdapter(undefined);
    assert.equal(adapter.getHomeUrl(), "https://www.tcdb.com");
  });

  it("advertises public, non-listing capabilities", () => {
    const adapter = new tcdb.TcdbAdapter(undefined);
    assert.equal(adapter.requiresAuth, false, "TCDB must not require auth");
    assert.equal(
      adapter.supportsListing,
      false,
      "TCDB is read-only — must not support listing",
    );
  });

  it("login() is a public no-op that succeeds without a key", async () => {
    const adapter = new tcdb.TcdbAdapter(undefined);
    const result = await adapter.login();
    assert.equal(result.success, true);
    assert.equal(result.message, "TCDB is public (no auth)");
  });

  it("login() ignores any key argument (no Secret Manager lookup)", async () => {
    const adapter = new tcdb.TcdbAdapter(undefined);
    // A bogus key must NOT cause a credential lookup or error — it's ignored.
    const result = await adapter.login("tcdb-credentials-whatever");
    assert.equal(result.success, true);
    assert.equal(result.message, "TCDB is public (no auth)");
  });

  it("cleanup() is a safe no-op when no browser was launched", async () => {
    const adapter = new tcdb.TcdbAdapter(undefined);
    // Must not throw even though the adapter never launched a browser.
    await adapter.cleanup();
  });
});

describe("createAdapter factory — tcdb", () => {
  it("returns a TcdbAdapter instance for site type 'tcdb'", () => {
    const adapter = createAdapter("tcdb", undefined);
    assert.ok(
      adapter instanceof tcdb.TcdbAdapter,
      "factory must return a TcdbAdapter for 'tcdb'",
    );
  });

  it("the factory-built TCDB adapter exposes a public no-op login", async () => {
    const adapter = createAdapter("tcdb", undefined);
    const result = await adapter.login();
    assert.equal(result.success, true);
    assert.equal(result.message, "TCDB is public (no auth)");
  });
});
