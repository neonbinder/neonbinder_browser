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
      if (!this.page) {
        return {
          success: false,
          error: "No browser page available"
        };
      }
      
      // Navigate to the login page
      const loginUrl = "https://www.sportlots.com/cust/custbin/login.tpl?urlval=/index.tpl&qs=";
      await this.page.goto(loginUrl, { waitUntil: 'networkidle2' });
      
      // Wait for the login form to be visible
      await this.page.waitForSelector('input[name="email_val"]', { timeout: 10000 });
      
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
      
      await this.page.type(emailSelector, credentials.username);
      await this.page.type(passwordSelector, credentials.password);
      
      // Click the sign in button
      const signInButton = await this.page.$('input[type="submit"][value="Sign-in"]');
      console.log(`[SportLots Adapter] Sign in button:`, signInButton);
      if (!signInButton) {
        return {
          success: false,
          error: "Could not find sign in button"
        };
      }
      
      await signInButton.click();
      console.log(`[SportLots Adapter] Clicked sign in button`);
      
      // Wait for navigation and check if login was successful
      await this.page.waitForNavigation({ waitUntil: 'networkidle0' });
      console.log(`[SportLots Adapter] Waited for navigation to ${this.page.url()}`);
      
      // Debug: Check what URL we're on after login
      const currentUrl = this.page.url();
      console.log(`[SportLots Adapter] After login, current URL:`, currentUrl);
      
      // Check if we're redirected to the main page and if username is visible
      if (currentUrl.includes('login.tpl')) {
        // Still on login page, check for error messages
        const errorElement = await this.page.$('.error, .alert, [class*="error"], [class*="alert"]');
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
          const element = await this.page.$(selector);
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
        const pageContent = await this.page.content();
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

  /**
   * Get available set parameters from SportLots
   * This method scrapes the SportLots website to find available options
   */
  async getAvailableSetParameters(partialParams: any, loginKey: string): Promise<any> {
    try {
      const { page } = await this.loginWithBrowser(loginKey);
      
      if (!page) {
        throw new Error("No browser page available");
      }

      const result: {
        availableOptions: {
          sports?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          years?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          manufacturers?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          setNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          variantNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
        };
        currentParams: any;
      } = {
        availableOptions: {},
        currentParams: partialParams,
      };

      // Now navigate to the newinven.tpl page (requires login)
      await page.goto("https://www.sportlots.com/inven/dealbin/newinven.tpl", { waitUntil: 'networkidle0' });

      // Debug the form fields to see what's actually available after login
      await this.debugFormFields(page);

      console.log(`[SportLots Adapter] Partial Params:`, partialParams);

      // Get sports if no sport is selected
      if (!partialParams.sport) {
        console.log(`[SportLots Adapter] No sport selected, scraping sports`);
        const sports = await this.scrapeSports(page);
        if (sports.length > 0) {
          result.availableOptions.sports = [{
            site: "SportLots",
            values: sports.map(sport => ({
              label: sport,
              value: sport
            }))
          }];
        }
      }

      // Get years if sport is selected but no year
      if (partialParams.sport && !partialParams.year) {
        console.log(`[SportLots Adapter] Sport selected, scraping years`);
        const years = await this.scrapeYears(page, partialParams.sport);
        if (years.length > 0) {
          result.availableOptions.years = [{
            site: "SportLots",
            values: years.map(year => ({
              label: year.toString(),
              value: year.toString()
            }))
          }];
        }
      }

      // Get manufacturers if sport and year are selected but no manufacturer
      if (partialParams.sport && partialParams.year && !partialParams.manufacturer) {
        console.log(`[SportLots Adapter] Sport and year selected, scraping manufacturers`);
        const manufacturers = await this.scrapeManufacturers(page, partialParams.sport, partialParams.year);
        if (manufacturers.length > 0) {
          result.availableOptions.manufacturers = [{
            site: "SportLots",
            values: manufacturers.map(manufacturer => ({
              label: manufacturer,
              value: manufacturer
            }))
          }];
        }
      }

      // Get set names if sport, year, and manufacturer are selected but no set name
      if (partialParams.sport && partialParams.year && partialParams.manufacturer && !partialParams.setName) {
        const setNames = await this.scrapeSetNames(page, partialParams.sport, partialParams.year, partialParams.manufacturer);
        if (setNames.length > 0) {
          result.availableOptions.setNames = [{
            site: "SportLots",
            values: setNames.map(setName => ({
              label: setName.name,
              value: setName.id
            }))
          }];
        }
      }

      console.log(`[SportLots Adapter] Result:`, result);
      return result;
    } catch (error) {
      console.error(`[SportLots Adapter] Error getting available set parameters:`, error);
      throw new Error(`Failed to get available set parameters: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Scrape available sports from SportLots
   */
  private async scrapeSports(page: any): Promise<string[]> {
    try {
      // Navigate to the correct page for scraping data (requires login)
      await page.goto("https://www.sportlots.com/inven/dealbin/newinven.tpl", { waitUntil: 'networkidle2' });
      
      // Wait for the sport dropdown to be available
      await page.waitForSelector('select[name="sprt"]', { timeout: 10000 });
      
      // Extract all sport options
      const sports = await page.evaluate(() => {
        const sportSelect = (document as any).querySelector('select[name="sprt"]') as any;
        if (!sportSelect) return [];
        
        const options = Array.from(sportSelect.options);
        return options
          .filter((option: any) => option.value && option.value !== '')
          .map((option: any) => option.textContent?.trim())
          .filter((text: any) => text && text.length > 0);
      });

      return sports;
    } catch (error) {
      console.error(`[SportLots Adapter] Error scraping sports:`, error);
      return [];
    }
  }

  /**
   * Scrape available years for a given sport
   */
  private async scrapeYears(page: any, sport: string): Promise<number[]> {
    try {      
      // Select the sport
      await page.select('select[name="sprt"]', sport);
      
      // Wait for the year dropdown to be populated
      await page.waitForSelector('select[name="yr"]', { timeout: 10000 });
      
      // Extract all year options
      const years = await page.evaluate(() => {
        const yearSelect = (document as any).querySelector('select[name="yr"]') as any;
        if (!yearSelect) return [];
        
        const options = Array.from(yearSelect.options);
        return options
          .filter((option: any) => option.value && option.value !== '')
          .map((option: any) => parseInt(option.value))
          .filter((year: any) => !isNaN(year));
      });

      console.log(`[SportLots Adapter] Years:`, years);
      return years;
    } catch (error) {
      console.error(`[SportLots Adapter] Error scraping years:`, error);
      return [];
    }
  }

  /**
   * Scrape available manufacturers for a given sport and year
   */
  private async scrapeManufacturers(page: any, sport: string, year: number): Promise<string[]> {
    try {      
      // Select the sport and year
      await page.select('select[name="sprt"]', sport);
      await page.select('select[name="yr"]', year.toString());
      
      // Wait for the manufacturer dropdown to be populated
      await page.waitForSelector('select[name="brd"]', { timeout: 10000 });
      
      // Extract all manufacturer options
      const manufacturers = await page.evaluate(() => {
        const brandSelect = (document as any).querySelector('select[name="brd"]') as any;
        if (!brandSelect) return [];
        
        const options = Array.from(brandSelect.options);
        return options
          .filter((option: any) => option.value && option.value !== '')
          .filter((option: any) => option.value !== 'All Brands')
          .map((option: any) => option.textContent?.trim())
          .filter((text: any) => text && text.length > 0);
      });

      return manufacturers;
    } catch (error) {
      console.error(`[SportLots Adapter] Error scraping manufacturers:`, error);
      return [];
    }
  }

  /**
   * Scrape available set names for a given sport, year, and manufacturer
   */
  private async scrapeSetNames(page: any, sport: string, year: number, manufacturer: string): Promise<Array<{name: string, id: string}>> {
    try {
      // Navigate to the correct page for scraping data
      await page.goto("https://www.sportlots.com/inven/dealbin/newinven.tpl", { waitUntil: 'networkidle2' });
      
      // Select the sport, year, and manufacturer
      await page.select('select[name="sprt"]', sport);
      await page.select('select[name="yr"]', year.toString());
      await page.select('select[name="brand"]', manufacturer);
      
      // Wait for the set dropdown to be populated
      await page.waitForSelector('select[name="set"]', { timeout: 10000 });
      
      // Extract all set options
      const setNames = await page.evaluate(() => {
        const setSelect = (document as any).querySelector('select[name="set"]') as any;
        if (!setSelect) return [];
        
        const options = Array.from(setSelect.options);
        return options
          .filter((option: any) => option.value && option.value !== '')
          .map((option: any) => ({
            name: option.textContent?.trim() || '',
            id: option.value
          }))
          .filter((set: any) => set.name && set.name.length > 0);
      });

      return setNames;
    } catch (error) {
      console.error(`[SportLots Adapter] Error scraping set names:`, error);
      return [];
    }
  }

  /**
   * Debug method to inspect form fields on the newinven.tpl page
   */
  private async debugFormFields(page: any): Promise<void> {
    try {
      console.log(`[SportLots Adapter] Debugging form fields on newinven.tpl page`);
      console.log(`[SportLots Adapter] Page URL:`, this.page?.url());
      
      const formFields = await page.evaluate(() => {
        const forms = (document as any).querySelectorAll('form');
        const fields: any = {};
        
        forms.forEach((form: any, formIndex: number) => {
          const selects = form.querySelectorAll('select');
          const inputs = form.querySelectorAll('input');
          
          fields[`form_${formIndex}`] = {
            action: form.action,
            method: form.method,
            selects: Array.from(selects).map((select: any) => ({
              name: select.name,
              id: select.id,
              className: select.className,
              options: Array.from(select.options).map((opt: any) => ({
                value: opt.value,
                text: opt.textContent?.trim()
              })).slice(0, 5) // Only first 5 options for debugging
            })),
            inputs: Array.from(inputs).map((input: any) => ({
              name: input.name,
              id: input.id,
              type: input.type,
              value: input.value
            }))
          };
        });
        
        return fields;
      });
      
      console.log(`[SportLots Adapter] Form fields found:`, JSON.stringify(formFields, null, 2));
    } catch (error) {
      console.error(`[SportLots Adapter] Error debugging form fields:`, error);
    }
  }
} 