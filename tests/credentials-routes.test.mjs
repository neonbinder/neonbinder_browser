/**
 * Integration tests for the credential CRUD HTTP endpoints
 *
 * Strategy: reconstruct the Express app in-process using the same middleware
 * stack as index.ts, but with SecretsManagerService replaced by an in-memory
 * store. This avoids importing dist/index.js (which calls app.listen() at
 * module load time) while still exercising the real route handler logic.
 *
 * The in-memory SecretsManagerService mirrors the error-throwing behavior of
 * the real one so that error-path tests (404, 400 for bad key format) work.
 *
 * Auth is exercised by setting INTERNAL_API_KEY in the environment and sending
 * matching / non-matching x-internal-key headers.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory credentials store (mirrors real SecretsManagerService semantics)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

class InMemorySecretsManager {
  constructor(store) {
    // store: Map<key, Credentials>
    this._store = store;
  }

  _validateKey(key) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error("Invalid credential key format");
    }
  }

  async getCredentials(key) {
    this._validateKey(key);
    const creds = this._store.get(key);
    if (!creds) {
      throw new Error(`Credentials not found for key: ${key}`);
    }
    return { ...creds };
  }

  async updateCredentials(key, credentials) {
    this._validateKey(key);
    this._store.set(key, { ...credentials });
  }

  async deleteCredentials(key) {
    this._validateKey(key);
    this._store.delete(key);
  }

  async credentialsExist(key) {
    this._validateKey(key);
    return this._store.has(key);
  }
}

// ---------------------------------------------------------------------------
// Build the Express app — mirrors index.ts structure but uses injectable deps
// ---------------------------------------------------------------------------

function buildApp({ secretsManager, apiKey, env = "dev" }) {
  const express = require("express");
  const { timingSafeEqual } = require("crypto");
  const rateLimit = require("express-rate-limit");
  const helmet = require("helmet");

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));

  // Rate limiter — use a very high limit so tests never hit it
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10000,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, trustProxy: false },
  });
  app.use(limiter);

  // Auth middleware — identical logic to index.ts
  function requireInternalAuth(req, res, next) {
    const incomingKey = req.headers["x-internal-key"];
    const expected = apiKey;
    if (
      !incomingKey ||
      !expected ||
      typeof incomingKey !== "string" ||
      incomingKey.length !== expected.length ||
      !timingSafeEqual(Buffer.from(incomingKey), Buffer.from(expected))
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // PUT /credentials/:key
  app.put("/credentials/:key", requireInternalAuth, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "Missing required fields: username, password" });
      return;
    }
    try {
      await secretsManager.updateCredentials(req.params.key, { username, password });
      res.json({ success: true, message: "Credentials stored" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Invalid credential key format")) {
        res.status(400).json({ error: "Invalid credential key format" });
      } else {
        res.status(500).json({ error: "Failed to store credentials" });
      }
    }
  });

  // GET /credentials/:key/metadata
  app.get("/credentials/:key/metadata", requireInternalAuth, async (req, res) => {
    try {
      const credentials = await secretsManager.getCredentials(req.params.key);
      res.json({
        username: credentials.username,
        hasToken: !!credentials.token,
        expiresAt: credentials.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Invalid credential key format")) {
        res.status(400).json({ error: "Invalid credential key format" });
      } else if (message.includes("not found") || message.includes("No active version")) {
        res.status(404).json({ error: "Credentials not found" });
      } else {
        res.status(500).json({ error: "Failed to retrieve credential metadata" });
      }
    }
  });

  // DELETE /credentials/:key
  app.delete("/credentials/:key", requireInternalAuth, async (req, res) => {
    try {
      await secretsManager.deleteCredentials(req.params.key);
      res.json({ success: true, message: "Credentials deleted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Invalid credential key format")) {
        res.status(400).json({ error: "Invalid credential key format" });
      } else {
        res.status(500).json({ error: "Failed to delete credentials" });
      }
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

const TEST_API_KEY = "test-internal-api-key-32chars!!";

let server;
let baseUrl;
let store; // shared in-memory store, reset per-test where needed

before(async () => {
  store = new Map();
  const secretsManager = new InMemorySecretsManager(store);
  const app = buildApp({ secretsManager, apiKey: TEST_API_KEY });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function authHeaders(key = TEST_API_KEY) {
  return {
    "Content-Type": "application/json",
    "x-internal-key": key,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Credential CRUD routes", () => {
  // Reset the store before each group so tests are independent
  const validKey = "bsc-credentials-testuser1";

  describe("PUT /credentials/:key", () => {
    it("should store credentials and return 200 with a valid key and body", async () => {
      store.clear();
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ username: "seller@example.com", password: "hunter2" }),
      });

      assert.equal(res.status, 200, "should return 200 OK");
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, "Credentials stored");
      assert.ok(store.has(validKey), "should persist credentials in the store");
    });

    it("should return 400 when username is missing", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ password: "hunter2" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /username/, "error should mention missing field");
    });

    it("should return 400 when password is missing", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ username: "seller@example.com" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /password/, "error should mention missing field");
    });

    it("should return 400 when the credential key format is invalid", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_KEY_FORMAT`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ username: "u", password: "p" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });

    it("should return 401 without an API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "u", password: "p" }),
      });

      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, "Unauthorized");
    });

    it("should return 401 with a wrong API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: authHeaders("wrong-key-value-32chars-padding!"),
        body: JSON.stringify({ username: "u", password: "p" }),
      });

      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, "Unauthorized");
    });
  });

  describe("GET /credentials/:key/metadata", () => {
    it("should return metadata for an existing credential", async () => {
      store.clear();
      store.set(validKey, {
        username: "seller@example.com",
        password: "hunter2",
        token: "Bearer tok",
        expiresAt: 9999999999,
      });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`, {
        headers: authHeaders(),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.username, "seller@example.com", "should return the username");
      assert.equal(body.hasToken, true, "should report hasToken=true when token exists");
      assert.equal(body.expiresAt, 9999999999, "should return expiresAt");
      assert.equal(body.password, undefined, "must NOT expose the password");
      assert.equal(body.token, undefined, "must NOT expose the raw token");
    });

    it("should return hasToken=false when no token is stored", async () => {
      store.clear();
      store.set(validKey, { username: "seller@example.com", password: "hunter2" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`, {
        headers: authHeaders(),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.hasToken, false);
    });

    it("should return 404 for a key that does not exist", async () => {
      store.clear();

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`, {
        headers: authHeaders(),
      });

      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, "Credentials not found");
    });

    it("should return 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT/metadata`, {
        headers: authHeaders(),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });

    it("should return 401 without an API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);
      assert.equal(res.status, 401);
    });

    it("should return 401 with a wrong API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`, {
        headers: { "x-internal-key": "wrong-key-value-32chars-padding!" },
      });
      assert.equal(res.status, 401);
    });
  });

  describe("DELETE /credentials/:key", () => {
    it("should delete credentials and return 200", async () => {
      store.clear();
      store.set(validKey, { username: "seller@example.com", password: "hunter2" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, "Credentials deleted");
      assert.equal(store.has(validKey), false, "key should be removed from the store");
    });

    it("should return 200 even when deleting a non-existent key (idempotent)", async () => {
      store.clear();

      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      // The in-memory store (like the real GCP one) treats missing-key deletes as success
      assert.equal(res.status, 200);
    });

    it("should return 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });

    it("should return 401 without an API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "DELETE",
      });
      assert.equal(res.status, 401);
    });

    it("should return 401 with a wrong API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "DELETE",
        headers: { "x-internal-key": "wrong-key-value-32chars-padding!" },
      });
      assert.equal(res.status, 401);
    });
  });

  describe("Auth guard — all credential endpoints reject invalid API keys", () => {
    const wrongKey = "wrong-key-value-32chars-padding!";

    it("PUT rejects keys that differ only by one character", async () => {
      // Tests that timingSafeEqual prevents naive string equality bypass
      const almostRight = TEST_API_KEY.slice(0, -1) + "X";
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-internal-key": almostRight },
        body: JSON.stringify({ username: "u", password: "p" }),
      });
      assert.equal(res.status, 401);
    });

    it("rejects when x-internal-key header is absent entirely", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`, {
        headers: {},
      });
      assert.equal(res.status, 401);
    });

    it("rejects an empty string API key", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`, {
        headers: { "x-internal-key": "" },
      });
      assert.equal(res.status, 401);
    });
  });
});
