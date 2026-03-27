import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { SUPPORTED_SITES } from "./adapters";
import { BSCAdapter } from "./adapters/bsc-adapter";
import { SecretsManagerService } from "./services/secrets-manager";

interface LoginResponse {
  success: boolean;
  message?: string;
  token?: string;
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
app.post("/login/sportlots", requireInternalAuth, async (req: Request<{}, {}, { key: string; username: string; password: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key, username, password } = req.body;
  if (!key || !username || !password) {
    res.status(400).json({ error: "Missing required fields: key, username, password" });
    return;
  }
  try {
    const secretsManager = new SecretsManagerService();

    // POST credentials to SportLots sign-in
    const loginUrl = "https://www.sportlots.com/cust/custbin/signin.tpl";
    const body = new URLSearchParams({
      email_val: username,
      psswd: password,
    });

    const response = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });

    // SportLots sets cookies via JavaScript in the response body, not HTTP headers
    const responseBody = await response.text();
    const cookieRegex = /document\.cookie\s*=\s*"([^"]+)"/g;
    const cookies: string[] = [];
    let cookieMatch;

    while ((cookieMatch = cookieRegex.exec(responseBody)) !== null) {
      // Each match is like: session_type=1;path=/;expires=...
      // Extract just the name=value part (index 0 after splitting on ;)
      const fullCookie = cookieMatch[1];
      const nameValue = fullCookie.split(";")[0].trim();
      if (nameValue) {
        cookies.push(nameValue);
      }
    }

    if (cookies.length === 0) {
      res.status(400).json({ error: "SportLots login failed. No session cookies received. Please check your credentials." });
      return;
    }

    const cookieString = cookies.join("; ");

    // Validate cookies work by fetching a protected page
    const validateResponse = await fetch("https://www.sportlots.com/inven/dealbin/newinven.tpl", {
      method: "GET",
      headers: { Cookie: cookieString },
      redirect: "manual",
    });
    const validateBody = await validateResponse.text();

    if (validateBody.includes("login.tpl") || validateBody.includes("signin.tpl")) {
      res.status(400).json({ error: "SportLots login validation failed. Cookies did not authenticate." });
      return;
    }

    // Store credentials + token in GCP
    await secretsManager.updateCredentials(key, { username, password, token: cookieString });

    res.json({ success: true, message: "SportLots credentials saved and validated successfully", token: cookieString });
  } catch (err) {
    console.error("Sportlots login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// BSC login endpoint: accepts username/password, stores in GCP, logs in via Puppeteer, returns token
app.post("/login/bsc", requireInternalAuth, async (req: Request<{}, {}, { key: string; username: string; password: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key, username, password } = req.body;
  if (!key || !username || !password) {
    res.status(400).json({ error: "Missing required fields: key, username, password" });
    return;
  }
  try {
    // Store credentials in GCP Secret Manager first
    const secretsManager = new SecretsManagerService();
    await secretsManager.updateCredentials(key, { username, password });

    // Now use the BSC adapter to log in and extract the token
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login(key);
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        token: result.token,
        expiresAt: result.expiresAt,
        storeName: result.storeName,
      });
    } else {
      res.status(500).json({ error: result.error || result.message || "BSC login failed" });
    }
  } catch (err) {
    console.error("BSC login failed:", err);
    const detail = err instanceof Error ? err.message : "BSC login failed";
    res.status(500).json({ error: detail });
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

// Get credentials for a key
app.get("/credentials/:key", requireInternalAuth, async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(req.params.key);
    res.json(credentials);
  } catch (err) {
    console.error("Failed to retrieve credentials:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else if (message.includes("not found") || message.includes("No active version")) {
      res.status(404).json({ error: "Credentials not found" });
    } else {
      res.status(500).json({ error: "Failed to retrieve credentials" });
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
  try {
    const secretsManager = new SecretsManagerService();
    const results: Record<string, boolean> = {};
    await Promise.all(
      req.body.keys.map(async (key) => {
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
