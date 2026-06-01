export { BaseAdapter, LoginCredentials, AdapterResponse } from "./base-adapter";
export { BSCAdapter } from "./bsc-adapter";
export { SportlotsAdapter } from "./sportlots-adapter";
export { TcdbAdapter } from "./tcdb-adapter";

import { Page } from "puppeteer";
import { BSCAdapter } from "./bsc-adapter";
import { SportlotsAdapter } from "./sportlots-adapter";
import { TcdbAdapter } from "./tcdb-adapter";
import { BaseAdapter } from "./base-adapter";

export type SiteType = "bsc" | "sportlots" | "tcdb";

export function createAdapter(siteType: SiteType, page: Page): BaseAdapter {
  switch (siteType) {
    case "bsc":
      return new BSCAdapter(page);
    case "sportlots":
      return new SportlotsAdapter(page);
    case "tcdb":
      return new TcdbAdapter(page);
    default:
      throw new Error(`Unknown site type: ${siteType}`);
  }
}

export const SUPPORTED_SITES: Record<SiteType, string> = {
  bsc: "BuySportsCards (BSC)",
  sportlots: "Sportlots",
  tcdb: "The Trading Card Database (TCDB)"
};
