import { BaseAdapter, AdapterResponse } from "./base-adapter";
import { SecretsManagerService } from "../services/secrets-manager";

export class SportlotsAdapter extends BaseAdapter {
  constructor(page: any) {
    super(page, "Sportlots");
  }

  getHomeUrl(): string {
    return "https://www.sportlots.com";
  }

  async login(key: string): Promise<AdapterResponse> {
    try {
      const { page } = await this.loginWithBrowser(key);
      
      if (!page) {
        return {
          success: false,
          error: "No browser page available"
        };
      }
      
      // Navigate to the login page
      const loginUrl = "https://sportlots.com/cust/custbin/login.tpl?urlval=/index.tpl&qs=";
      await page.goto(loginUrl, { waitUntil: 'networkidle2' });
      
      // Wait for the login form to be visible
      await page.waitForSelector('input[name="email_val"]', { timeout: 10000 });
      
      // Get credentials using the base adapter's Secret Manager integration
      const secretsManager = new SecretsManagerService();
      const credentials = await secretsManager.getCredentials(key);
      if (!credentials.username || !credentials.password) {
        return {
          success: false,
          error: "Invalid credentials format"
        };
      }

      // Fill in the login form
      const emailSelector = 'input[name="email_val"]';
      const passwordSelector = 'input[name="psswd"]';
      
      await page.type(emailSelector, credentials.username);
      await page.type(passwordSelector, credentials.password);
      
      // Click the sign in button
      const signInButton = await page.$('input[type="submit"][value="Sign-in"]');
      if (!signInButton) {
        return {
          success: false,
          error: "Could not find sign in button"
        };
      }
      
      await signInButton.click();
      
      // Wait for navigation and check if login was successful
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
      
      // Check if we're redirected to the main page and if username is visible
      const currentUrl = page.url();
      if (currentUrl.includes('login.tpl')) {
        // Still on login page, check for error messages
        const errorElement = await page.$('.error, .alert, [class*="error"], [class*="alert"]');
        if (errorElement) {
          const errorText = await errorElement.evaluate(el => el.textContent);
          return {
            success: false,
            error: `Login failed: ${errorText?.trim() || 'Invalid credentials'}`
          };
        }
        return {
          success: false,
          error: "Login failed - still on login page"
        };
      }
      
      // Check if username is visible at the top right (common pattern for logged in users)
      const usernameSelectors = [
        '.user-info',
        '.user-name',
        '.username',
        '.account-info',
        '[class*="user"]',
        '[class*="account"]',
        'a[href*="logout"]',
        'a[href*="account"]'
      ];
      
      let usernameVisible = false;
      for (const selector of usernameSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            const text = await element.evaluate(el => el.textContent);
            if (text && text.trim().length > 0) {
              usernameVisible = true;
              break;
            }
          }
        } catch (e) {
          // Continue to next selector
        }
      }
      
      if (!usernameVisible) {
        // Try to find any indication of successful login
        const pageContent = await page.content();
        if (pageContent.includes('logout') || pageContent.includes('account') || pageContent.includes('profile')) {
          usernameVisible = true;
        }
      }
      
      if (usernameVisible) {
        return {
          success: true,
          message: `Successfully logged into ${this.siteName} as ${credentials.username}`
        };
      } else {
        return {
          success: false,
          error: "Login may have failed - username not visible at top right"
        };
      }
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to login to ${this.siteName}: ${error}`
      };
    }
  }


} 