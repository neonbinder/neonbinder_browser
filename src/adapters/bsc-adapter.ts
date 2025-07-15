import { Page } from "puppeteer";
import { BaseAdapter, AdapterResponse } from "./base-adapter";
import { SecretsManagerService } from "../services/secrets-manager";

export class BSCAdapter extends BaseAdapter {
  constructor(page?: Page) {
    super(page, "BuySportsCards (BSC)");
  }

  getHomeUrl(): string {
    return "https://www.buysportscards.com";
  }

  async login(key: string): Promise<AdapterResponse> {
    // Fetch credentials internally
    const secretsManager = new SecretsManagerService();
    // First, try to get a token or a page from loginWithBrowser
    const result = await this.loginWithBrowser(key);
    if (result.token) {
      console.log(`[BSC Adapter] Using cached token for ${this.siteName}`);
      return {
        success: true,
        message: `Used cached token for ${this.siteName}`,
        expiresAt: Date.now() + (60 * 60 * 1000), // Dummy expiry for now
      };
    }
    // If we have a page, continue with the BSC login process as before
    const bscPage = result.page || this.page;
    if (!bscPage) throw new Error('No Puppeteer page available for BSC login');

    console.log(`[BSC Adapter] Starting login process for ${this.siteName}`);
    const credentials = await secretsManager.getCredentials(key);
    try {
      // Use credentials passed from the request
      const { username: email, password } = credentials;
      
      if (!email || !password) {
        console.error(`[BSC Adapter] Missing credentials: email=${!!email}, password=${!!password}`);
        return {
          success: false,
          error: `Missing credentials for ${this.siteName}`,
        };
      }
      
      console.log(`[BSC Adapter] Credentials found, navigating to ${this.getHomeUrl()}`);

      // Navigate to home
      console.log(`[BSC Adapter] Navigating to home page...`);
      await bscPage.goto(this.getHomeUrl(), { waitUntil: "networkidle2" });
      console.log(`[BSC Adapter] Successfully navigated to home page`);

      // take a screenshot of the page
      await bscPage.screenshot({ path: "screenshot.png" });

      // Look for Sign In button first (most common case)
      console.log(`[BSC Adapter] Looking for Sign In button...`);
      let signInClicked = false;
      try {
        await bscPage.locator('button').filter(button => button.innerText?.toLowerCase() === 'sign in').click();
        signInClicked = true;
        console.log(`[BSC Adapter] Successfully clicked Sign In button`);
      } catch (e) {
        console.log(`[BSC Adapter] Error clicking Sign In button:`, e);
        console.log(`[BSC Adapter] Sign In button not found, checking for Sign Out button...`);
      }
      if (!signInClicked) {
        // Sign In not found, check if we're already signed in (Sign Out button exists)
        let signOutClicked = false;
        try {
          await bscPage.locator('button:has-text("Sign Out")').setTimeout(1000).click();
          signOutClicked = true;
          console.log(`[BSC Adapter] Found Sign Out button, clicked to sign out first...`);
        } catch (e) {
          // Neither Sign In nor Sign Out found
          throw new Error('Neither Sign In nor Sign Out button found');
        }
        if (signOutClicked) {
          // Wait a moment for the sign out to complete
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Now look for Sign In button again
          try {
            await bscPage.locator('button:has-text("Sign In")').setTimeout(1000).click();
            console.log(`[BSC Adapter] Found Sign In button after sign out, clicking...`);
          } catch (e) {
            throw new Error('Sign In button not found after sign out');
          }
        }
      }

      // Fill in email and password
      console.log(`[BSC Adapter] Looking for login form fields...`);
      try {
        await bscPage.waitForSelector("#signInName", { timeout: 5000 });
        console.log(`[BSC Adapter] Found email field, typing email...`);
        await bscPage.type("#signInName", email);
        console.log(`[BSC Adapter] Typed email, typing password...`);
        await bscPage.type("#password", password);
        console.log(`[BSC Adapter] Successfully filled in credentials`);
      } catch (error) {
        console.error(`[BSC Adapter] Error filling in credentials:`, error);
        return {
          success: false,
          error: `Failed to fill in credentials: ${error}`,
        };
      }

      // Click Next
      console.log(`[BSC Adapter] Clicking Next button...`);
      try {
        await bscPage.locator('button:has-text("Next")').setTimeout(1000).click();
        console.log(`[BSC Adapter] Successfully clicked Next button`);
      } catch (error) {
        // fallback to id
        const nextButtonById = await bscPage.$("#next");
        if (nextButtonById) {
          await nextButtonById.click();
          console.log(`[BSC Adapter] Successfully clicked Next button by id`);
        } else {
          console.error(`[BSC Adapter] Error clicking Next button:`, error);
          throw new Error('Next button not found');
        }
      }

      // Extract token from localStorage
      console.log(`[BSC Adapter] Extracting token from localStorage...`);
      await bscPage.waitForFunction(() => {
        // Look for a localStorage value containing "Bearer"
        // @ts-ignore
        // eslint-disable-next-line
        return Object.values(window.localStorage).some(
          (value) => typeof value === "string" && value.includes("Bearer")
        );
      }, { timeout: 30000 });
      const reduxAsString = await bscPage.evaluate(() => {
        // Extract token from localStorage
        // @ts-ignore
        // eslint-disable-next-line
        return Object.values(window.localStorage)
          .filter((value) => typeof value === "string" && value.includes("secret"))
          .find((value) => typeof value === "string" && value.includes("Bearer"));
      });

      const redux = reduxAsString ? JSON.parse(reduxAsString as string) : {};
      const token = redux.secret ? redux.secret.trim() : undefined;
      const expiresAt = Date.now() + (60 * 60 * 1000); // 1 hour from now in milliseconds
      console.log(`[BSC Adapter] Extracted token from localStorage.`);
      
      if (!token) {
        console.warn(`[BSC Adapter] No token found in localStorage`);
        return {
          success: false,
          error: `No Auth Token found in during login process`,
        };
      } else {
        // Store the token and expiry in the secret manager
        await secretsManager.updateCredentials(key, {
          ...credentials,
          token,
          expiresAt
        });
        console.log(`[BSC Adapter] Stored token in Secret Manager for ${this.siteName}`);
        return {
          success: true,
          message: `Successfully logged into ${this.siteName}`,
          token,
          expiresAt,
        };
      }
      
    } catch (error) {
      console.error(`[BSC Adapter] Error during login process:`, error);
      return {
        success: false,
        error: `Error during login process: ${error}`,
      };
    }

    
    // Add a fallback return in case something goes wrong and no other return is hit
    return {
      success: false,
      error: `Unknown error occurred during login for ${this.siteName}`,
    };
  }
}