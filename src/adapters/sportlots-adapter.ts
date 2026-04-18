import { BaseAdapter, AdapterResponse } from "./base-adapter";
import { SecretsManagerService } from "../services/secrets-manager";

// Retry budget for transient SportLots failures.
// Backoffs apply BETWEEN attempts: 1→2, 2→3, 3→4, 4→5.
// Total max added sleep ≈ 7.5s; well inside Cloud Run's default timeout.
const MAX_ATTEMPTS = 5;
const BACKOFFS_MS = [500, 1000, 2000, 4000];

function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = baseMs * (Math.random() * 0.6 - 0.3); // ±30%
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, baseMs + jitter)));
}

export class SportlotsAdapter extends BaseAdapter {
  constructor(page: any) {
    super(page, "Sportlots");
  }

  getHomeUrl(): string {
    return "https://www.sportlots.com";
  }

  /**
   * Login to SportLots via HTTP POST, extract JS-set cookies from response body.
   * Retries up to MAX_ATTEMPTS on transient failures (429, 5xx, network error,
   * empty cookie body); returns immediately on permanent failures (4xx non-429,
   * invalid credentials, validation seeing a login page).
   */
  async login(key: string): Promise<AdapterResponse> {
    let last: AdapterResponse = { success: false, error: "Login did not run" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.log(
          `[SportLots Adapter] retry attempt ${attempt}/${MAX_ATTEMPTS} — previous error: ${last.error}`,
        );
      }
      last = await this.attemptLogin(key, attempt);
      if (last.success) return last;
      if (!last.retryable || attempt === MAX_ATTEMPTS) return last;
      await sleepWithJitter(BACKOFFS_MS[attempt - 1]);
    }
    return last;
  }

  /**
   * Single login attempt. Sets `retryable: true` on error branches we want the
   * outer loop to retry (transient upstream issues, empty body); leaves it
   * undefined on permanent errors so the caller bails immediately.
   */
  private async attemptLogin(key: string, attempt: number): Promise<AdapterResponse> {
    const t0 = Date.now();
    const log = (msg: string) =>
      console.log(`[SportLots Adapter] ${msg} (t+${Date.now() - t0}ms, attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      log("login start");
      const secretsManager = new SecretsManagerService();
      const credentials = await secretsManager.getCredentials(key);
      if (!credentials.username || !credentials.password) {
        log("credentials missing username/password");
        return {
          success: false,
          error: "Invalid credentials format",
        };
      }

      const loginUrl = "https://www.sportlots.com/cust/custbin/signin.tpl";
      const body = new URLSearchParams({
        email_val: credentials.username,
        psswd: credentials.password,
      });

      log("POST /cust/custbin/signin.tpl");
      const response = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "manual",
      });
      log(`login response status=${response.status}`);

      // Check for upstream failures before parsing cookies
      if (response.status === 429) {
        log("login rejected: 429 rate limit");
        return {
          success: false,
          error: "SportLots rate limit exceeded. Please try again later.",
          retryable: true,
        };
      }
      if (response.status >= 500) {
        log(`login rejected: upstream ${response.status}`);
        return {
          success: false,
          error: `SportLots is unavailable (HTTP ${response.status}). Please try again later.`,
          retryable: true,
        };
      }
      if (response.status >= 400) {
        log(`login rejected: upstream ${response.status}`);
        return {
          success: false,
          error: `SportLots returned an error (HTTP ${response.status}).`,
        };
      }

      const responseBody = await response.text();
      log(`login body received bytes=${responseBody.length}`);

      // SportLots sets cookies via JavaScript in the response body
      const cookieRegex = /document\.cookie\s*=\s*"([^"]+)"/g;
      const cookies: string[] = [];
      let cookieMatch;

      while ((cookieMatch = cookieRegex.exec(responseBody)) !== null) {
        const nameValue = cookieMatch[1].split(";")[0].trim();
        if (nameValue) {
          cookies.push(nameValue);
        }
      }
      log(`parsed ${cookies.length} cookie(s) from body`);

      if (cookies.length === 0) {
        // Most often a blank/slow body from SL; retry once. If SL genuinely
        // changed their response format we'll see it in the preview over
        // multiple retries.
        const preview = responseBody.slice(0, 200).replace(/\s+/g, " ");
        log(`no cookies parsed; body preview: ${preview}`);
        return {
          success: false,
          error: "No session cookies received. Check credentials.",
          retryable: true,
        };
      }

      const cookieString = cookies.join("; ");

      // Validate cookies actually authenticate by fetching a protected page
      log("GET /inven/dealbin/newinven.tpl (validation)");
      const validateResponse = await fetch("https://www.sportlots.com/inven/dealbin/newinven.tpl", {
        method: "GET",
        headers: { Cookie: cookieString },
        redirect: "manual",
      });
      const validateBody = await validateResponse.text();
      log(
        `validation response status=${validateResponse.status} bytes=${validateBody.length}`,
      );

      if (validateBody.includes("login.tpl") || validateBody.includes("signin.tpl")) {
        const preview = validateBody.slice(0, 200).replace(/\s+/g, " ");
        log(`validation body contained login/signin reference; preview: ${preview}`);
        return {
          success: false,
          error: "SportLots login validation failed. Cookies did not authenticate.",
        };
      }

      // Store the cookie as a token
      await secretsManager.updateCredentials(key, {
        username: credentials.username,
        password: credentials.password,
        token: cookieString,
      });
      log("login success; token stored");

      return {
        success: true,
        message: `Successfully logged into ${this.siteName}`,
      };
    } catch (error) {
      log(`login threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      return {
        success: false,
        error: `Failed to login to ${this.siteName}: ${error}`,
        retryable: true,
      };
    }
  }
}
