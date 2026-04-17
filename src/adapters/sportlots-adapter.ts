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
    try {
      const secretsManager = new SecretsManagerService();
      const credentials = await secretsManager.getCredentials(key);
      if (!credentials.username || !credentials.password) {
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

      const response = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "manual",
      });

      // Check for upstream failures before parsing cookies
      if (response.status === 429) {
        return { success: false, error: "SportLots rate limit exceeded. Please try again later." };
      }
      if (response.status >= 500) {
        return { success: false, error: `SportLots is unavailable (HTTP ${response.status}). Please try again later.` };
      }
      if (response.status >= 400) {
        return { success: false, error: `SportLots returned an error (HTTP ${response.status}).` };
      }

      const responseBody = await response.text();

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

      if (cookies.length === 0) {
        return {
          success: false,
          error: "No session cookies received. Check credentials.",
        };
      }

      const cookieString = cookies.join("; ");

      // Validate cookies actually authenticate by fetching a protected page
      const validateResponse = await fetch("https://www.sportlots.com/inven/dealbin/newinven.tpl", {
        method: "GET",
        headers: { Cookie: cookieString },
        redirect: "manual",
      });
      const validateBody = await validateResponse.text();

      if (validateBody.includes("login.tpl") || validateBody.includes("signin.tpl")) {
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

      return {
        success: true,
        message: `Successfully logged into ${this.siteName}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to login to ${this.siteName}: ${error}`,
      };
    }
  }
}
