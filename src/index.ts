import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { SUPPORTED_SITES } from "./adapters";
import { BSCAdapter } from "./adapters/bsc-adapter";
import { SportlotsAdapter } from "./adapters/sportlots-adapter";
import { SecretsManagerService } from "./services/secrets-manager";

interface LoginResponse {
  success: boolean;
  message?: string;
  expiresAt?: number;
  storeName?: string;
}

interface ErrorResponse {
  error: string;
}

interface SitesResponse {
  sites: Record<string, string>;
}

const ENV = process.env.ENVIRONMENT || "dev";
const app = express();

// Trust proxy headers from Cloud Run / load balancers (not in dev — breaks express-rate-limit)
if (ENV !== "dev") {
  app.set("trust proxy", true);
}

// Security middleware
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,               // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: ENV === "dev" ? { xForwardedForHeader: false, trustProxy: false } : true,
});
app.use(limiter);

// --- Timing-safe authentication middleware ---
function requireInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-internal-key"];
  const expected = process.env.INTERNAL_API_KEY;

  if (
    !apiKey ||
    !expected ||
    typeof apiKey !== "string" ||
    apiKey.length !== expected.length ||
    !timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected))
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Health endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", environment: ENV });
});

// Get list of supported sites (requires auth)
app.get("/sites", requireInternalAuth, (_req: Request, res: Response<SitesResponse>) => {
  res.json({ sites: SUPPORTED_SITES });
});

// Site-specific login endpoints
app.post("/login/sportlots", requireInternalAuth, async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key } = req.body;
  if (!key) {
    res.status(400).json({ error: "Missing required field: key" });
    return;
  }
  try {
    // Adapter reads credentials from Secret Manager internally
    const adapter = new SportlotsAdapter(undefined);
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ error: result.error || "SportLots login failed" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      console.error("Sportlots login failed:", err);
      res.status(500).json({ error: "Login failed" });
    }
  }
});

// BSC login endpoint: accepts username/password, stores in GCP, logs in via Puppeteer
app.post("/login/bsc", requireInternalAuth, async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key } = req.body;
  if (!key) {
    res.status(400).json({ error: "Missing required field: key" });
    return;
  }
  try {
    // Adapter reads credentials from Secret Manager internally
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login(key);
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        expiresAt: result.expiresAt,
        storeName: result.storeName,
      });
    } else {
      res.status(500).json({ error: result.error || result.message || "BSC login failed" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      console.error("BSC login failed:", err);
      res.status(500).json({ error: "BSC login failed" });
    }
  }
});

// --- Credential CRUD endpoints ---

// Store credentials for a key (no marketplace validation)
app.put("/credentials/:key", requireInternalAuth, async (req: Request<{ key: string }, {}, { username: string; password: string }>, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "Missing required fields: username, password" });
    return;
  }
  try {
    const secretsManager = new SecretsManagerService();
    await secretsManager.updateCredentials(req.params.key, { username, password });
    res.json({ success: true, message: "Credentials stored" });
  } catch (err) {
    console.error("Failed to store credentials:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      res.status(500).json({ error: "Failed to store credentials" });
    }
  }
});

// Get credential metadata (no secrets) for a key
app.get("/credentials/:key/metadata", requireInternalAuth, async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
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
      console.error("Failed to retrieve credential metadata:", err);
      res.status(500).json({ error: "Failed to retrieve credential metadata" });
    }
  }
});

// Get token only (for internal adapter use — no username/password exposed)
app.get("/credentials/:key/token", requireInternalAuth, async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(req.params.key);
    if (!credentials.token) {
      res.status(404).json({ error: "No token available" });
      return;
    }
    res.json({
      token: credentials.token,
      expiresAt: credentials.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else if (message.includes("not found") || message.includes("No active version")) {
      res.status(404).json({ error: "Credentials not found" });
    } else {
      console.error("Failed to retrieve token:", err);
      res.status(500).json({ error: "Failed to retrieve token" });
    }
  }
});

// Delete credentials for a key
app.delete("/credentials/:key", requireInternalAuth, async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    await secretsManager.deleteCredentials(req.params.key);
    res.json({ success: true, message: "Credentials deleted" });
  } catch (err) {
    console.error("Failed to delete credentials:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      res.status(500).json({ error: "Failed to delete credentials" });
    }
  }
});

// Check which keys have credentials
app.post("/credentials/check", requireInternalAuth, async (req: Request<{}, {}, { keys: string[] }>, res: Response) => {
  const { keys } = req.body || {};
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    res.status(400).json({ error: "Invalid request body: 'keys' must be an array of strings" });
    return;
  }
  try {
    const secretsManager = new SecretsManagerService();
    const results: Record<string, boolean> = {};
    await Promise.all(
      keys.map(async (key) => {
        results[key] = await secretsManager.credentialsExist(key);
      })
    );
    res.json({ results });
  } catch (err) {
    console.error("Failed to check credentials:", err);
    res.status(500).json({ error: "Failed to check credentials" });
  }
});

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`[${ENV}] Listening on port ${PORT}`));
