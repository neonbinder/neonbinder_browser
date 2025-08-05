import express, { Request, Response } from "express";
import { SiteType, SUPPORTED_SITES } from "./adapters";
import { SportlotsAdapter } from "./adapters/sportlots-adapter";

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

// SportLots selector options endpoint
interface GetSelectorOptionsRequest {
  level: "sport" | "year" | "manufacturer" | "setName" | "variantType" | "insert" | "parallel";
  parentFilters?: {
    sport?: string;
    year?: number;
    manufacturer?: string;
    setName?: string;
    variantType?: "base" | "parallel" | "insert" | "parallel_of_insert";
  };
  loginKey: string; // Add login key parameter
}

interface GetSelectorOptionsResponse {
  success: boolean;
  message: string;
  optionsCount: number;
  options: Array<{
    value: string;
    platformData: {
      sportlots: string;
    };
  }>;
}

const app = express();
app.use(express.json());

// Get list of supported sites
app.get("/sites", (_req: Request, res: Response<SitesResponse>) => {
  res.json({ sites: SUPPORTED_SITES });
});

// Login to a specific site
app.post("/login", async (req: Request<{}, {}, LoginRequest>, res: Response<LoginResponse | ErrorResponse>) => {
  const { site, key } = req.body;
  try {
    let adapter;
    if (site === 'sportlots') {
      adapter = new SportlotsAdapter(undefined);
    } else {
      res.status(400).json({ error: `Unsupported site: ${site}` });
      return;
    }
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.error || "Login failed" });
    }
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Site-specific login endpoints
app.post("/login/sportlots", async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const { key } = req.body;
  try {
    const adapter = new SportlotsAdapter(undefined);
    const result = await adapter.login(key);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.error || "Login failed" });
    }
  } catch (err) {
    console.error("Sportlots login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * Get selector options from SportLots
 * 
 * This endpoint scrapes the SportLots website to retrieve available options for the hierarchical set building process.
 * It requires authentication via loginKey and supports filtering based on previously selected parameters.
 * 
 * @example
 * // Get all available sports
 * curl -X POST "http://localhost:8080/get-selector-options" \
 *   -H "Content-Type: application/json" \
 *   -d '{"level": "sport", "loginKey": "sportlots-credentials-jx79mrchxfk068z36fkah2sf2s7jpnma"}'
 * 
 * @example
 * // Get available years for Football
 * curl -X POST "http://localhost:8080/get-selector-options" \
 *   -H "Content-Type: application/json" \
 *   -d '{"level": "year", "parentFilters": {"sport": "Football"}, "loginKey": "sportlots-credentials-jx79mrchxfk068z36fkah2sf2s7jpnma"}'
 * 
 * @example
 * // Get available manufacturers for Football 2022
 * curl -X POST "http://localhost:8080/get-selector-options" \
 *   -H "Content-Type: application/json" \
 *   -d '{"level": "manufacturer", "parentFilters": {"sport": "Football", "year": "2022"}, "loginKey": "sportlots-credentials-jx79mrchxfk068z36fkah2sf2s7jpnma"}'
 * 
 * @param {string} level - The hierarchical level to retrieve options for. Must be one of: "sport", "year", "manufacturer", "setName", "variantType", "insert", "parallel"
 * @param {Object} [parentFilters] - Optional filters based on previously selected values
 * @param {string} [parentFilters.sport] - Selected sport (e.g., "Football", "Baseball")
 * @param {number} [parentFilters.year] - Selected year (e.g., 2022, 2023)
 * @param {string} [parentFilters.manufacturer] - Selected manufacturer (e.g., "Donruss", "Bowman")
 * @param {string} [parentFilters.setName] - Selected set name
 * @param {string} [parentFilters.variantType] - Selected variant type ("base", "parallel", "insert", "parallel_of_insert")
 * @param {string} loginKey - The secret key for SportLots credentials stored in Google Secret Manager
 * 
 * @returns {Object} Response object containing:
 *   - success: boolean - Whether the operation was successful
 *   - message: string - Human-readable message about the operation
 *   - optionsCount: number - Number of options found
 *   - options: Array<{value: string, platformData: {sportlots: string}}> - Array of available options
 * 
 * @example Response for sports:
 * {
 *   "success": true,
 *   "message": "Successfully found 5 sport options from SportLots",
 *   "optionsCount": 5,
 *   "options": [
 *     {"value": "Baseball", "platformData": {"sportlots": "BB"}},
 *     {"value": "Basketball", "platformData": {"sportlots": "BK"}},
 *     {"value": "Football", "platformData": {"sportlots": "FB"}},
 *     {"value": "Golf", "platformData": {"sportlots": "GF"}},
 *     {"value": "Hockey", "platformData": {"sportlots": "HK"}}
 *   ]
 * }
 * 
 * @example Response for manufacturers:
 * {
 *   "success": true,
 *   "message": "Successfully found 13 manufacturer options from SportLots",
 *   "optionsCount": 13,
 *   "options": [
 *     {"value": "Bowman", "platformData": {"sportlots": "Bowman"}},
 *     {"value": "Donruss", "platformData": {"sportlots": "Donruss"}},
 *     {"value": "Fleer", "platformData": {"sportlots": "Fleer"}},
 *     {"value": "ITG", "platformData": {"sportlots": "ITG"}}
 *   ]
 * }
 * 
 * @throws {Error} When login fails or SportLots scraping encounters an error
 * @throws {Error} When loginKey is invalid or credentials are not found
 * 
 * @note This endpoint requires the browser service to be running and authenticated with SportLots
 * @note The loginKey must correspond to a valid secret in Google Secret Manager containing SportLots credentials
 * @note SportLots uses different internal values (e.g., "FB" for Football) which are stored in platformData
 */
app.post("/get-selector-options", async (req: Request<{}, {}, GetSelectorOptionsRequest>, res: Response<GetSelectorOptionsResponse | ErrorResponse>) => {
  try {
    const { level, parentFilters, loginKey } = req.body;
    
    console.log(`[get-selector-options] Getting ${level} options from SportLots with filters:`, parentFilters);

    // Get options from SportLots
    let sportlotsOptions: Array<{ value: string; platformData: any }> = [];
    try {
      const sportlotsAdapter = new SportlotsAdapter(undefined);
      const sportlotsResult = await sportlotsAdapter.getAvailableSetParameters(parentFilters || {}, loginKey);
      
      if (sportlotsResult.availableOptions) {
        const levelKey = level === "sport" ? "sports" : 
                        level === "year" ? "years" : 
                        level === "manufacturer" ? "manufacturers" : 
                        level === "setName" ? "setNames" : 
                        level === "variantType" ? "variantNames" : 
                        level;
        
        const options = sportlotsResult.availableOptions[levelKey as keyof typeof sportlotsResult.availableOptions];
        if (options && Array.isArray(options) && options.length > 0) {
          sportlotsOptions = options.flatMap((siteOption: any) => 
            siteOption.values.map((value: any) => ({
              value: value.label,
              platformData: { sportlots: value.value }
            }))
          );
        }
      }
    } catch (error) {
      console.error(`[get-selector-options] SportLots error:`, error);
    }

    console.log(`[get-selector-options] Successfully found ${sportlotsOptions.length} ${level} options from SportLots`);
    
    res.json({
      success: true,
      message: `Successfully found ${sportlotsOptions.length} ${level} options from SportLots`,
      optionsCount: sportlotsOptions.length,
      options: sportlotsOptions,
    });
  } catch (error) {
    console.error(`[get-selector-options] Error:`, error);
    res.status(500).json({ 
      error: `Failed to get selector options: ${error instanceof Error ? error.message : 'Unknown error'}` 
    });
  }
});

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`)); 