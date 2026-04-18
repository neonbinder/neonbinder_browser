import { BaseAdapter, AdapterResponse } from "./base-adapter";
import { SecretsManagerService } from "../services/secrets-manager";

export class SportlotsAdapter extends BaseAdapter {
  constructor(page: any) {
    super(page, "Sportlots");
  }

  getHomeUrl(): string {
    return "https://www.sportlots.com";
  }

  /**
   * Login to SportLots via HTTP POST, extract JS-set cookies from response body.
   * All scraping now happens via direct HTTP in the Convex adapter — this method
   * only handles credential validation and cookie extraction.
   */
  async login(key: string): Promise<AdapterResponse> {
    const t0 = Date.now();
    const log = (msg: string) =>
      console.log(`[SportLots Adapter] ${msg} (t+${Date.now() - t0}ms)`);
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
        return { success: false, error: "SportLots rate limit exceeded. Please try again later." };
      }
      if (response.status >= 500) {
        log(`login rejected: upstream ${response.status}`);
        return { success: false, error: `SportLots is unavailable (HTTP ${response.status}). Please try again later.` };
      }
      if (response.status >= 400) {
        log(`login rejected: upstream ${response.status}`);
        return { success: false, error: `SportLots returned an error (HTTP ${response.status}).` };
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
        // Include a hint from the body so we can see whether SL changed
        // the cookie-set shape or returned an unexpected page.
        const preview = responseBody.slice(0, 200).replace(/\s+/g, " ");
        log(`no cookies parsed; body preview: ${preview}`);
        return {
          success: false,
          error: "No session cookies received. Check credentials.",
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
      };
    }
  }
}
