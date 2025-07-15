import { SecretsManagerService } from "../services/secrets-manager";
import puppeteer, { Browser, Page } from "puppeteer";

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AdapterResponse {
  success: boolean;
  message?: string;
  error?: string;
  token?: string;
  expiresAt?: number;
}

export abstract class BaseAdapter {
  protected page?: Page;
  protected siteName: string;
  protected token?: string;

  constructor(page: Page | undefined, siteName: string) {
    this.page = page;
    this.siteName = siteName;
  }

  abstract getHomeUrl(): string;
  abstract login(key: string): Promise<AdapterResponse>;
  
  protected async navigateToHome(): Promise<void> {
    try {
      if (!this.page) throw new Error('No Puppeteer page available in adapter');
      await this.page.goto(this.getHomeUrl(), { waitUntil: "networkidle2" });
    } catch (error) {
      throw new Error(`Failed to navigate to ${this.siteName} home page: ${error}`);
    }
  }

  protected async waitForElement(selector: string, timeout: number = 10000): Promise<void> {
    try {
      if (!this.page) throw new Error('No Puppeteer page available in adapter');
      await this.page.waitForSelector(selector, { timeout });
    } catch (error) {
      throw new Error(`Element not found: ${selector} on ${this.siteName}`);
    }
  }

  /**
   * Handles browser and token logic for login. If a valid token is found, sets this.token and returns { token }.
   * Otherwise, launches Puppeteer, sets this.page, and returns { page }.
   */
  async loginWithBrowser(key: string, page?: Page | null): Promise<{ token?: string; page?: Page }> {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(key);
    // If credentials have a non-expired token, use it and return
    if (credentials.token && credentials.expiresAt && credentials.expiresAt > Date.now()) {
      this.token = credentials.token;
      return { token: credentials.token };
    }
    // Otherwise, create a browser and page if not provided
    let browser: Browser | null = null;
    if (!page) {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1920,1080"],
      });
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
    }
    this.page = page;
    return { page };
  }
} 