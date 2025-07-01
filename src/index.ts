import express, { Request, Response } from "express";
import puppeteer, { Browser, Page } from "puppeteer";
import { createAdapter, SiteType, SUPPORTED_SITES, LoginCredentials } from "./adapters";
import { SecretsManagerService } from "./services/secrets-manager";

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

  let browser: Browser | null = null;

  try {
    // Get credentials from Secret Manager
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(key);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page: Page = await browser.newPage();
    const adapter = createAdapter(site, page);
    
    const loginCredentials: LoginCredentials = { 
      username: credentials.username, 
      password: credentials.password 
    };
    const result = await adapter.login(loginCredentials);

    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(500).json({
        error: result.error || "Login failed"
      });
    }
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`)); 