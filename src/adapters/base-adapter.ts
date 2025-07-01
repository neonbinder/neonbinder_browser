import { Page } from "puppeteer";

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AdapterResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export abstract class BaseAdapter {
  protected page: Page;
  protected siteName: string;

  constructor(page: Page, siteName: string) {
    this.page = page;
    this.siteName = siteName;
  }

  abstract getHomeUrl(): string;
  abstract login(credentials: LoginCredentials): Promise<AdapterResponse>;
  
  protected async navigateToHome(): Promise<void> {
    try {
      await this.page.goto(this.getHomeUrl(), { waitUntil: "networkidle2" });
    } catch (error) {
      throw new Error(`Failed to navigate to ${this.siteName} home page: ${error}`);
    }
  }

  protected async waitForElement(selector: string, timeout: number = 10000): Promise<void> {
    try {
      await this.page.waitForSelector(selector, { timeout });
    } catch (error) {
      throw new Error(`Element not found: ${selector} on ${this.siteName}`);
    }
  }
} 