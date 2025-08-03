import express, { Request, Response } from "express";
import { SiteType, SUPPORTED_SITES } from "./adapters";
import { SecretsManagerService } from "./services/secrets-manager";
import { BSCAdapter } from "./adapters/bsc-adapter";
import { SportlotsAdapter } from "./adapters/sportlots-adapter";

interface LoginRequest {
  site: SiteType;
  key: string;
}

interface LoginResponse {
  success: boolean;
  message?: string;
}

interface ErrorResponse {
  error: string;
}

interface SitesResponse {
  sites: Record<string, string>;
}

interface SecretsResponse {
  secrets: string[];
}

const app = express();
app.use(express.json());

// Get list of supported sites
app.get("/sites", (_req: Request, res: Response<SitesResponse>) => {
  res.json({ sites: SUPPORTED_SITES });
});

// Get list of available secrets
app.get("/secrets", async (_req: Request, res: Response<SecretsResponse | ErrorResponse>) => {
  try {
    const secretsManager = new SecretsManagerService();
    const secrets = await secretsManager.listSecrets();
    res.json({ secrets });
  } catch (error) {
    console.error("Failed to list secrets:", error);
    res.status(500).json({ error: "Failed to list secrets" });
  }
});

// Login to a specific site
app.post("/login", async (req: Request<{}, {}, LoginRequest>, res: Response<LoginResponse | ErrorResponse>) => {
  const { site, key } = req.body;
  try {
    let adapter;
    if (site === 'bsc') {
      adapter = new BSCAdapter();
    } else if (site === 'sportlots') {
      adapter = new SportlotsAdapter(undefined);
    } else {
      // Add other adapters as needed
      res.status(400).json({ error: `Unsupported site: ${site}` });
      return;
    }
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.error || "Login failed" });
    }
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Site-specific login endpoints
app.post("/login/bsc", async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key } = req.body;
  try {
    const adapter = new BSCAdapter();
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.error || "Login failed" });
    }
  } catch (err) {
    console.error("BSC login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/login/sportlots", async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key } = req.body;
  try {
    const adapter = new SportlotsAdapter(undefined);
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.error || "Login failed" });
    }
  } catch (err) {
    console.error("Sportlots login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`)); 