/**
 * Response Limiter - Smart truncation for LLM tool responses
 *
 * Ensures tool responses never exceed token limits while preserving
 * essential information and full data in database.
 */

export interface ToolResponseLimits {
  maxProperties: number;      // Max properties to return to LLM
  maxChars: number;            // Max characters (~4 chars = 1 token)
  essentialFields: string[];   // Fields to include in truncated responses
}

export const TOOL_RESPONSE_LIMITS: ToolResponseLimits = {
  maxProperties: 20,
  maxChars: 10000,  // ~2500 tokens
  essentialFields: [
    'ListingKey',           // PRIMARY - required for frontend identification
    'UnparsedAddress',      // Full address
    'ListPrice',            // Price
    'BedroomsTotal',        // Bedrooms
    'BathroomsTotalInteger',// Bathrooms
    'LivingArea',           // Square footage
    'City',                 // City
    'StateOrProvince'       // State
  ]
};

interface LimitedResponse {
  summary: string;
  count?: number;
  statistics?: any;
  properties?: any[];
  sample?: any[];
  data?: any;
  resultType?: string;
  savedToDatabase: boolean;
  searchId: string;
  note: string;
  executionTimeMs?: number;
  size?: string;
}

/**
 * Create a limited response that respects token budgets
 * while providing essential information to the LLM
 */
export function createLimitedResponse(
  data: any,
  searchId: string,
  executionTimeMs: number,
  limits: ToolResponseLimits = TOOL_RESPONSE_LIMITS
): LimitedResponse {
  const isArray = Array.isArray(data);

  // Case 1: Small array (<= maxProperties)
  if (isArray && data.length <= limits.maxProperties) {
    return {
      summary: `Found ${data.length} ${data.length === 1 ? 'property' : 'properties'}`,
      count: data.length,
      properties: data.map(p => extractEssentialFields(p, limits.essentialFields)),
      savedToDatabase: true,
      searchId,
      note: 'Full results saved to database and sent to frontend',
      executionTimeMs
    };
  }

  // Case 2: Large array (> maxProperties)
  if (isArray && data.length > limits.maxProperties) {
    const statistics = calculateStatistics(data);

    return {
      summary: `Found ${data.length} properties. Showing ${limits.maxProperties} samples.`,
      count: data.length,
      statistics,
      sample: data
        .slice(0, limits.maxProperties)
        .map(p => extractEssentialFields(p, limits.essentialFields)),
      savedToDatabase: true,
      searchId,
      note: `All ${data.length} filtered properties now displayed on frontend map/listview`,
      executionTimeMs
    };
  }

  // Case 3: Non-array data (statistics, aggregations, etc.)
  if (!isArray) {
    const json = JSON.stringify(data);

    // Small enough to return as-is
    if (json.length <= limits.maxChars) {
      return {
        summary: 'Calculated result',
        resultType: typeof data === 'object' ? 'statistics' : typeof data,
        data,
        savedToDatabase: true,
        searchId,
        note: 'Result saved to database',
        executionTimeMs
      };
    }

    // Too large - truncate
    return {
      summary: 'Result too large for display',
      resultType: 'truncated',
      data: json.substring(0, limits.maxChars) + '...',
      savedToDatabase: true,
      searchId,
      note: 'Full result saved to database (preview shown)',
      size: `${Math.round(json.length / 1024)}KB`,
      executionTimeMs
    };
  }

  // Fallback: empty result
  return {
    summary: 'No results',
    count: 0,
    savedToDatabase: true,
    searchId,
    note: 'Empty result set',
    executionTimeMs
  };
}

/**
 * Extract only essential fields from a property object
 * to minimize token usage
 */
export function extractEssentialFields(
  property: any,
  fields: string[] = TOOL_RESPONSE_LIMITS.essentialFields
): Record<string, any> {
  const extracted: Record<string, any> = {};

  for (const field of fields) {
    if (property[field] !== undefined && property[field] !== null) {
      extracted[field] = property[field];
    }
  }

  return extracted;
}

/**
 * Calculate statistics for a property array
 * to provide meaningful summary when truncating
 */
export function calculateStatistics(properties: any[]): {
  priceRange?: {
    min: number;
    max: number;
    avg: number;
  };
  bedroomRange?: {
    min: number;
    max: number;
  };
  bathroomRange?: {
    min: number;
    max: number;
  };
  cities?: Record<string, number>;
  averageSquareFeet?: number;
} {
  if (!properties || properties.length === 0) {
    return {};
  }

  const stats: any = {};

  // Price statistics
  const prices = properties
    .map(p => p.ListPrice)
    .filter((p): p is number => typeof p === 'number' && !isNaN(p));

  if (prices.length > 0) {
    stats.priceRange = {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length)
    };
  }

  // Bedroom statistics
  const bedrooms = properties
    .map(p => p.BedroomsTotal)
    .filter((b): b is number => typeof b === 'number' && !isNaN(b));

  if (bedrooms.length > 0) {
    stats.bedroomRange = {
      min: Math.min(...bedrooms),
      max: Math.max(...bedrooms)
    };
  }

  // Bathroom statistics
  const bathrooms = properties
    .map(p => p.BathroomsTotalInteger)
    .filter((b): b is number => typeof b === 'number' && !isNaN(b));

  if (bathrooms.length > 0) {
    stats.bathroomRange = {
      min: Math.min(...bathrooms),
      max: Math.max(...bathrooms)
    };
  }

  // City distribution (top 5 cities)
  const cityCount: Record<string, number> = {};
  properties.forEach(p => {
    if (p.City && typeof p.City === 'string') {
      cityCount[p.City] = (cityCount[p.City] || 0) + 1;
    }
  });

  if (Object.keys(cityCount).length > 0) {
    const topCities = Object.entries(cityCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .reduce((acc, [city, count]) => {
        acc[city] = count;
        return acc;
      }, {} as Record<string, number>);

    stats.cities = topCities;
  }

  // Average square footage
  const sqFeet = properties
    .map(p => p.LivingArea)
    .filter((a): a is number => typeof a === 'number' && !isNaN(a));

  if (sqFeet.length > 0) {
    stats.averageSquareFeet = Math.round(
      sqFeet.reduce((sum, a) => sum + a, 0) / sqFeet.length
    );
  }

  return stats;
}

/**
 * Format a limited response as a JSON string for LLM consumption
 */
export function formatLimitedResponse(response: LimitedResponse): string {
  return JSON.stringify(response, null, 2);
}
