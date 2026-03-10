import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { SiteType, SUPPORTED_SITES } from "./adapters";
import { SportlotsAdapter } from "./adapters/sportlots-adapter";
import { BSCAdapter } from "./adapters/bsc-adapter";
import { SecretsManagerService } from "./services/secrets-manager";

interface LoginRequest {
  site: SiteType;
  key: string;
}

interface LoginResponse {
  success: boolean;
  message?: string;
  token?: string;
  expiresAt?: number;
}

interface ErrorResponse {
  error: string;
}

interface SitesResponse {
  sites: Record<string, string>;
}

// SportLots selector options endpoint
interface GetSelectorOptionsRequest {
  level: "sport" | "year" | "manufacturer" | "setName" | "variantType" | "insert" | "parallel";
  parentFilters?: {
    sport?: string;
    year?: number;
    manufacturer?: string;
    setName?: string;
    variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
  };
  loginKey: string; // Add login key parameter
}

interface GetSelectorOptionsResponse {
  success: boolean;
  message: string;
  optionsCount: number;
  options: Array<{
    value: string;
    platformData: {
      sportlots: string;
    };
  }>;
}

const ENV = process.env.ENVIRONMENT || "dev";
const app = express();

// Security middleware
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,               // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
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

// Login to a specific site
app.post("/login", requireInternalAuth, async (req: Request<{}, {}, LoginRequest>, res: Response<LoginResponse | ErrorResponse>) => {
  const { site, key } = req.body;
  try {
    let adapter;
    if (site === 'sportlots') {
      adapter = new SportlotsAdapter(undefined);
    } else {
      res.status(400).json({ error: `Unsupported site: ${site}` });
      return;
    }
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: "Login failed" });
    }
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Site-specific login endpoints
app.post("/login/sportlots", requireInternalAuth, async (req: Request<{}, {}, { key: string; username?: string; password?: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key, username, password } = req.body;
  try {
    const secretsManager = new SecretsManagerService();

    // If username/password provided, store in GCP and validate via HTTP login
    if (username && password) {
      await secretsManager.updateCredentials(key, { username, password });

      // Validate by doing a direct HTTP POST to SportLots login URL
      const loginUrl = "https://www.sportlots.com/cust/custbin/login.tpl";
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

      const setCookieHeaders = response.headers.getSetCookie?.() || [];
      const hasCookie = setCookieHeaders.length > 0 || !!response.headers.get("set-cookie");

      if (hasCookie) {
        res.json({ success: true, message: "SportLots credentials saved and validated successfully" });
      } else {
        // Credentials stored but login validation failed — remove them
        try {
          await secretsManager.deleteCredentials(key);
        } catch {
          // Best effort cleanup
        }
        res.status(400).json({ error: "SportLots login validation failed. Please check your credentials." });
      }
      return;
    }

    // If only key: read from GCP and validate (backward compatible)
    const adapter = new SportlotsAdapter(undefined);
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: "Login failed" });
    }
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
      });
    } else {
      res.status(500).json({ error: "BSC login failed" });
    }
  } catch (err) {
    console.error("BSC login failed:", err);
    res.status(500).json({ error: "BSC login failed" });
  }
});

// --- Credential CRUD endpoints ---

// Get credentials for a key
app.get("/credentials/:key", requireInternalAuth, async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(req.params.key);
    res.json(credentials);
  } catch (err) {
    console.error("Failed to retrieve credentials:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("not found") || message.includes("No active version")) {
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
    res.status(500).json({ error: "Failed to delete credentials" });
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

// --- Selector options endpoint ---
app.post("/get-selector-options", requireInternalAuth, async (req: Request<{}, {}, GetSelectorOptionsRequest>, res: Response<GetSelectorOptionsResponse | ErrorResponse>) => {
  try {
    const { level, parentFilters, loginKey } = req.body;

    console.log(`[get-selector-options] Getting ${level} options from SportLots with filters:`, parentFilters);

    // Get options from SportLots
    let sportlotsOptions: Array<{ value: string; platformData: any }> = [];
    try {
      const sportlotsAdapter = new SportlotsAdapter(undefined);
      const sportlotsResult = await sportlotsAdapter.getAvailableSetParameters(parentFilters || {}, loginKey);

      if (sportlotsResult.availableOptions) {
        const levelKey = level === "sport" ? "sports" :
                        level === "year" ? "years" :
                        level === "manufacturer" ? "manufacturers" :
                        level === "setName" ? "setNames" :
                        level === "variantType" ? "variantNames" :
                        level;

        const options = sportlotsResult.availableOptions[levelKey as keyof typeof sportlotsResult.availableOptions];
        if (options && Array.isArray(options) && options.length > 0) {
          sportlotsOptions = options.flatMap((siteOption: any) =>
            siteOption.values.map((value: any) => ({
              value: value.label,
              platformData: { sportlots: value.value }
            }))
          );
        }
      }
    } catch (error) {
      console.error(`[get-selector-options] SportLots error:`, error);
    }

    console.log(`[get-selector-options] Successfully found ${sportlotsOptions.length} ${level} options from SportLots`);

    res.json({
      success: true,
      message: `Successfully found ${sportlotsOptions.length} ${level} options from SportLots`,
      optionsCount: sportlotsOptions.length,
      options: sportlotsOptions,
    });
  } catch (error) {
    console.error(`[get-selector-options] Error:`, error);
    res.status(500).json({ error: "Failed to get selector options" });
  }
});

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`[${ENV}] Listening on port ${PORT}`));
