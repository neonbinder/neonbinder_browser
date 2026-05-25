/**
 * Unit tests for the TCDB adapter scoring helpers. We only exercise the
 * pure functions here (jaroWinkler, scoreMatch) — Puppeteer-driven paths
 * are covered by the deployed smoke tests because Cloudflare rendering
 * is intractable to mock and fragile to stub.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tcdb = require("../dist/adapters/tcdb-adapter.js");

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
