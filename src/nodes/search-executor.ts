import { Client } from '@elastic/elasticsearch';
import { Pool } from 'pg';
import { AgentStateType } from '../types/state.js';
import { MappedQuery } from '../subgraphs/property-search/types/mapped-query.js';
import { sharedPublisher } from '../pubsub/shared.js';

// ES client
const esClient = new Client({
  node: process.env.ELASTICSEARCH_NODE_V2 || 'http://34.134.5.206:9201',
  auth: {
    username: process.env.ELASTICSEARCH_USER_V2 || 'esuser',
    password: process.env.ELASTICSEARCH_PASS_V2 || 'espass123'
  }
});

// PG client
const pgPool = new Pool({
  host: process.env.TRESTLE_PG_HOST || '34.61.254.83',
  port: 5432,
  database: 'property_search',
  user: 'postgres',
  password: process.env.TRESTLE_PG_PASSWORD || 'C2Plq6bqGZpu23sHOOd57Ocb4'
});

const ES_LOCATION_INDEX = 'properties';
const ES_FEATURES_INDEX = 'properties_features';

const FEATURE_FIELDS = [
  'pool_features', 'view', 'exterior_features', 'interior_features',
  'flooring', 'appliances', 'heating', 'cooling', 'parking_features',
  'utilities', 'features', 'pets_allowed'
];

export interface SearchResult {
  listingKey: string;
  locationScore: number;
  featureScore: number;
  combinedScore: number;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  status?: string;
  propertyType?: string;
  propertySubType?: string;
  yearBuilt?: number;
  latitude?: number;
  longitude?: number;
  photoUrl?: string;
  // Frontend compatibility fields (added for UI image display)
  Media?: string[];  // Array format expected by frontend PropertySummary
  image?: string;    // Convenience field for quick access
  // Listing agent info (from raw_data JSONB)
  listAgentFullName?: string;
  listAgentMlsId?: string;
  listOfficeName?: string;
  listAgentEmail?: string;
  listAgentDirectPhone?: string;
  // Note: rawData removed from search results for performance
  // Use property_get_full_details tool to fetch complete property data
}

// Internal filters - matches hybrid-search.ts HybridSearchFilters
interface InternalFilters {
  locationQuery?: string;
  cities?: string[];
  postalCodes?: string[];
  counties?: string[];
  featuresQuery?: string;
  minPrice?: number;
  maxPrice?: number;
  minBedrooms?: number;
  maxBedrooms?: number;
  minBathrooms?: number;
  maxBathrooms?: number;
  propertyType?: string[];
  propertySubType?: string;  // Single string, not array
  status?: string;           // Single string, not array
  minSqft?: number;
  maxSqft?: number;
  minLotSqft?: number;
  maxLotSqft?: number;
  minYearBuilt?: number;
  maxYearBuilt?: number;
  // Boolean filters - re-enabled with data quality improvements
  poolYn?: boolean;
  waterfrontYn?: boolean;
  garageYn?: boolean;
  newConstructionYn?: boolean;
  seniorCommunityYn?: boolean;
  // View types filter
  viewTypes?: string[];
}

/**
 * Convert MappedQuery to internal filters (matching hybrid-search.ts schema)
 */
function convertToFilters(query: MappedQuery): InternalFilters {
  const filters: InternalFilters = {};

  // Location
  if (query.location.query) filters.locationQuery = query.location.query;
  if (query.location.cities?.length) filters.cities = query.location.cities;
  if (query.location.postalCodes?.length) filters.postalCodes = query.location.postalCodes;
  if (query.location.counties?.length) filters.counties = query.location.counties;

  // Features
  if (query.features.query) filters.featuresQuery = query.features.query;

  // Strict filters - convert null to undefined
  const s = query.strict;
  if (s.minPrice !== null) filters.minPrice = s.minPrice;
  if (s.maxPrice !== null) filters.maxPrice = s.maxPrice;
  if (s.minBeds !== null) filters.minBedrooms = s.minBeds;
  // IMPORTANT: Only set maxBedrooms if it makes a valid range (LLM bug workaround)
  // Skip if maxBeds < minBeds (impossible filter) or maxBeds === minBeds (redundant)
  if (s.maxBeds !== null && (s.minBeds === null || s.maxBeds > s.minBeds)) {
    filters.maxBedrooms = s.maxBeds;
  }
  if (s.minBaths !== null) filters.minBathrooms = s.minBaths;
  if (s.maxBaths !== null && s.maxBaths !== s.minBaths) filters.maxBathrooms = s.maxBaths;
  if (s.minSqft !== null) filters.minSqft = s.minSqft;
  if (s.maxSqft !== null) filters.maxSqft = s.maxSqft;
  if (s.minLotSqft !== null) filters.minLotSqft = s.minLotSqft;
  if (s.maxLotSqft !== null) filters.maxLotSqft = s.maxLotSqft;
  if (s.propertyType?.length) filters.propertyType = s.propertyType;
  // propertySubType is now a single string - guard against LLM returning invalid values like ":null"
  if (s.propertySubType && s.propertySubType !== ':null' && s.propertySubType !== 'null') {
    filters.propertySubType = s.propertySubType;
  }
  // status is now a single string - guard against LLM returning invalid values like ":null"
  if (s.status && s.status !== ':null' && s.status !== 'null') {
    filters.status = s.status;
  }
  // Year built
  if (s.minYearBuilt !== null) filters.minYearBuilt = s.minYearBuilt;
  if (s.maxYearBuilt !== null) filters.maxYearBuilt = s.maxYearBuilt;

  // Boolean filters - re-enabled
  if (s.poolYn === true) filters.poolYn = true;
  if (s.waterfrontYn === true) filters.waterfrontYn = true;
  if (s.garageYn === true) filters.garageYn = true;
  if (s.newConstructionYn === true) filters.newConstructionYn = true;
  if (s.seniorCommunityYn === true) filters.seniorCommunityYn = true;

  // View types filter
  if (s.viewTypes?.length) filters.viewTypes = s.viewTypes;

  return filters;
}

/**
 * ES Location Search with strict filters
 */
async function esLocationSearch(filters: InternalFilters): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  const hasQuery = !!filters.locationQuery;
  const hasCities = filters.cities && filters.cities.length > 0;
  const hasPostalCodes = filters.postalCodes && filters.postalCodes.length > 0;
  const hasCounties = filters.counties && filters.counties.length > 0;
  const hasStrictFilters = filters.minPrice !== undefined || filters.maxPrice !== undefined ||
    filters.minBedrooms !== undefined || filters.maxBedrooms !== undefined ||
    filters.minBathrooms !== undefined || filters.maxBathrooms !== undefined ||
    filters.status || filters.propertyType?.length || filters.propertySubType ||
    filters.minSqft !== undefined || filters.maxSqft !== undefined ||
    filters.minYearBuilt !== undefined || filters.maxYearBuilt !== undefined;

  if (!hasQuery && !hasCities && !hasPostalCodes && !hasCounties && !hasStrictFilters) {
    return results;
  }

  const filter: object[] = [];
  const should: object[] = [];

  // City filter - use terms query on city.keyword for EXACT matching
  // This prevents "Miami Beach" from matching "North Miami Beach"
  if (hasCities) {
    filter.push({ terms: { 'city.keyword': filters.cities } });
  }

  // Postal codes
  if (hasPostalCodes) {
    filter.push({ terms: { postal_code: filters.postalCodes } });
  }

  // County filter - exact match on county field
  if (hasCounties) {
    filter.push({ terms: { county: filters.counties } });
  }

  // Location query - boosted address fields for better relevance
  // Higher boosts ensure exact address matches rank significantly higher
  // Also searches subdivision_name and building_name for building/complex searches
  if (hasQuery) {
    should.push(
      { match: { unparsed_address: { query: filters.locationQuery, boost: 10.0 } } },
      { match: { normalized_address: { query: filters.locationQuery, boost: 8.0 } } },
      { match: { street_name: { query: filters.locationQuery, boost: 5.0 } } },
      // Add subdivision/building name search for queries like "La Perla" or "Mystic Pointe"
      { match: { subdivision_name: { query: filters.locationQuery, boost: 12.0 } } },
      { match: { building_name: { query: filters.locationQuery, boost: 12.0 } } },
      // Also search enhanced_address which contains building + subdivision + county
      { match: { searchable_address: { query: filters.locationQuery, boost: 8.0 } } }
    );
  }

  // Price range
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const range: Record<string, number> = {};
    if (filters.minPrice !== undefined) range.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) range.lte = filters.maxPrice;
    filter.push({ range: { list_price: range } });
  }

  // Bedrooms
  if (filters.minBedrooms !== undefined || filters.maxBedrooms !== undefined) {
    const range: Record<string, number> = {};
    if (filters.minBedrooms !== undefined) range.gte = filters.minBedrooms;
    if (filters.maxBedrooms !== undefined) range.lte = filters.maxBedrooms;
    filter.push({ range: { bedrooms: range } });
  }

  // Bathrooms
  if (filters.minBathrooms !== undefined || filters.maxBathrooms !== undefined) {
    const range: Record<string, number> = {};
    if (filters.minBathrooms !== undefined) range.gte = filters.minBathrooms;
    if (filters.maxBathrooms !== undefined) range.lte = filters.maxBathrooms;
    filter.push({ range: { bathrooms: range } });
  }

  // Square feet (living area)
  if (filters.minSqft !== undefined || filters.maxSqft !== undefined) {
    const range: Record<string, number> = {};
    if (filters.minSqft !== undefined) range.gte = filters.minSqft;
    if (filters.maxSqft !== undefined) range.lte = filters.maxSqft;
    filter.push({ range: { square_feet: range } });
  }

  // Lot size (land area)
  if (filters.minLotSqft !== undefined || filters.maxLotSqft !== undefined) {
    const range: Record<string, number> = {};
    if (filters.minLotSqft !== undefined) range.gte = filters.minLotSqft;
    if (filters.maxLotSqft !== undefined) range.lte = filters.maxLotSqft;
    filter.push({ range: { lot_size_square_feet: range } });
  }

  // Status - single string value (not array)
  if (filters.status) {
    filter.push({ term: { standard_status: filters.status } });
  }

  // Property type - array
  if (filters.propertyType?.length) {
    filter.push({ terms: { property_type: filters.propertyType } });
  }

  // Property sub type - single string value (not array)
  if (filters.propertySubType) {
    filter.push({ term: { property_sub_type: filters.propertySubType } });
  }

  // Year built range
  if (filters.minYearBuilt !== undefined || filters.maxYearBuilt !== undefined) {
    const range: Record<string, number> = {};
    if (filters.minYearBuilt !== undefined) range.gte = filters.minYearBuilt;
    if (filters.maxYearBuilt !== undefined) range.lte = filters.maxYearBuilt;
    filter.push({ range: { year_built: range } });
  }

  // Boolean filters - re-enabled
  if (filters.poolYn === true) {
    filter.push({ term: { pool_private_yn: true } });
  }
  if (filters.waterfrontYn === true) {
    filter.push({ term: { waterfront_yn: true } });
  }
  if (filters.garageYn === true) {
    filter.push({ term: { garage_yn: true } });
  }
  if (filters.newConstructionYn === true) {
    filter.push({ term: { new_construction_yn: true } });
  }
  if (filters.seniorCommunityYn === true) {
    filter.push({ term: { senior_community_yn: true } });
  }

  // View types filter - match any of the specified view types
  if (filters.viewTypes?.length) {
    filter.push({ terms: { view_types: filters.viewTypes } });
  }

  const boolQuery: Record<string, unknown> = {};
  if (filter.length > 0) boolQuery.filter = filter;
  if (should.length > 0) {
    boolQuery.should = should;
    // Only require address match when:
    // 1. There's a location query AND
    // 2. We DON'T have explicit city/postal filters (which will constrain results anyway)
    // This allows "Mystic Pointe Aventura" to work even if address doesn't match
    const hasExplicitLocationFilters = hasCities || hasPostalCodes;
    if (hasQuery && !hasExplicitLocationFilters) {
      boolQuery.minimum_should_match = 1;
    }
  }

  if (Object.keys(boolQuery).length === 0) {
    return results;
  }

  const response = await esClient.search({
    index: ES_LOCATION_INDEX,
    size: 10000,
    _source: ['listing_key'],
    query: { bool: boolQuery }
  });

  for (const hit of response.hits.hits) {
    const source = hit._source as { listing_key: string };
    results.set(source.listing_key, hit._score || 0);
  }

  return results;
}

/**
 * ES Features Search
 *
 * IMPORTANT: When locationKeys is undefined (location search returned 0 results),
 * we MUST still enforce strict filters to prevent returning random properties.
 */
async function esFeaturesSearch(
  filters: InternalFilters,
  locationKeys?: string[],
  enforceStrictFilters = false
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // If we have location keys, pass them through even without feature query
  if (!filters.featuresQuery && !enforceStrictFilters) {
    if (locationKeys?.length) {
      for (const key of locationKeys) results.set(key, 0);
    }
    return results;
  }

  const filter: object[] = [];
  const should: object[] = [];

  // Constrain to location results if available
  if (locationKeys?.length) {
    filter.push({ terms: { listing_key: locationKeys } });
  }

  // CRITICAL FIX: Apply strict filters when doing feature-only search
  // This prevents returning properties from everywhere when location search returns 0
  if (enforceStrictFilters || !locationKeys?.length) {
    // City filter - use city.keyword for exact matching
    if (filters.cities?.length) {
      filter.push({ terms: { 'city.keyword': filters.cities } });
    }

    // County filter - exact match on county field
    if (filters.counties?.length) {
      filter.push({ terms: { county: filters.counties } });
    }

    // Price range
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minPrice !== undefined) range.gte = filters.minPrice;
      if (filters.maxPrice !== undefined) range.lte = filters.maxPrice;
      filter.push({ range: { list_price: range } });
    }

    // Bedrooms
    if (filters.minBedrooms !== undefined || filters.maxBedrooms !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minBedrooms !== undefined) range.gte = filters.minBedrooms;
      if (filters.maxBedrooms !== undefined) range.lte = filters.maxBedrooms;
      filter.push({ range: { bedrooms: range } });
    }

    // Bathrooms
    if (filters.minBathrooms !== undefined || filters.maxBathrooms !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minBathrooms !== undefined) range.gte = filters.minBathrooms;
      if (filters.maxBathrooms !== undefined) range.lte = filters.maxBathrooms;
      filter.push({ range: { bathrooms: range } });
    }

    // Status - single string value
    if (filters.status) {
      filter.push({ term: { standard_status: filters.status } });
    }

    // Property type - array
    if (filters.propertyType?.length) {
      filter.push({ terms: { property_type: filters.propertyType } });
    }

    // Property sub type - single string
    if (filters.propertySubType) {
      filter.push({ term: { property_sub_type: filters.propertySubType } });
    }

    // Square feet (living area)
    if (filters.minSqft !== undefined || filters.maxSqft !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minSqft !== undefined) range.gte = filters.minSqft;
      if (filters.maxSqft !== undefined) range.lte = filters.maxSqft;
      filter.push({ range: { square_feet: range } });
    }

    // Lot size (land area)
    if (filters.minLotSqft !== undefined || filters.maxLotSqft !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minLotSqft !== undefined) range.gte = filters.minLotSqft;
      if (filters.maxLotSqft !== undefined) range.lte = filters.maxLotSqft;
      filter.push({ range: { lot_size_square_feet: range } });
    }

    // Year built
    if (filters.minYearBuilt !== undefined || filters.maxYearBuilt !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minYearBuilt !== undefined) range.gte = filters.minYearBuilt;
      if (filters.maxYearBuilt !== undefined) range.lte = filters.maxYearBuilt;
      filter.push({ range: { year_built: range } });
    }
  }

  // Feature query scoring (if provided)
  if (filters.featuresQuery) {
    const queryLower = filters.featuresQuery.toLowerCase();
    for (const field of FEATURE_FIELDS) {
      should.push({ term: { [field]: { value: queryLower, boost: 3.0 } } });
    }
    should.push({ match: { public_remarks: { query: filters.featuresQuery, boost: 1.5 } } });
  }

  const boolQuery: Record<string, unknown> = {};
  if (filter.length > 0) boolQuery.filter = filter;
  if (should.length > 0) {
    boolQuery.should = should;
    // Only require match if we have a feature query
    if (filters.featuresQuery) {
      boolQuery.minimum_should_match = 1;
    }
  }

  // If no filters or should clauses, return empty
  if (Object.keys(boolQuery).length === 0) {
    return results;
  }

  const response = await esClient.search({
    index: ES_FEATURES_INDEX,
    size: 2000,
    _source: ['listing_key'],
    query: { bool: boolQuery }
  });

  for (const hit of response.hits.hits) {
    const source = hit._source as { listing_key: string };
    results.set(source.listing_key, hit._score || 0);
  }

  return results;
}

/**
 * Fetch property data from PG
 */
async function fetchProperties(
  listingKeys: string[],
  locationScores: Map<string, number>,
  featureScores: Map<string, number>,
  combinedScores: Map<string, number>,
  limit = 50
): Promise<SearchResult[]> {
  if (listingKeys.length === 0) return [];

  const keysToFetch = listingKeys.slice(0, limit);

  // PERFORMANCE OPTIMIZATION: Removed JSONB extractions (saves ~2-3 seconds)
  // Photo URL and agent info are fetched on-demand via property_get_full_details tool
  const result = await pgPool.query(`
    SELECT
      tp.listing_key,
      tp.unparsed_address,
      tp.city,
      tp.state_or_province as state,
      tp.postal_code,
      tp.list_price,
      tp.bedrooms_total,
      tp.bathrooms_total_integer as bathrooms_total,
      tp.living_area,
      tp.standard_status,
      tp.property_type,
      tp.property_sub_type,
      tp.year_built,
      tp.latitude,
      tp.longitude
      -- REMOVED for performance (90% faster without JSONB extraction):
      -- tp.raw_data->'Media'->0->>'MediaURL' as photo_url,
      -- tp.raw_data->>'ListAgentFullName' as list_agent_full_name,
      -- tp.raw_data->>'ListAgentMlsId' as list_agent_mls_id,
      -- tp.raw_data->>'ListOfficeName' as list_office_name,
      -- tp.raw_data->>'ListAgentEmail' as list_agent_email,
      -- tp.raw_data->>'ListAgentDirectPhone' as list_agent_direct_phone
      -- Use property_get_full_details tool to fetch complete property data on-demand
    FROM trestle_properties tp
    WHERE tp.listing_key = ANY($1)
  `, [keysToFetch]);

  const rowMap = new Map(result.rows.map(r => [r.listing_key, r]));

  return keysToFetch
    .filter(key => rowMap.has(key))
    .map(key => {
      const row = rowMap.get(key)!;
      return {
        listingKey: key,
        locationScore: locationScores.get(key) || 0,
        featureScore: featureScores.get(key) || 0,
        combinedScore: combinedScores.get(key) || 0,
        address: row.unparsed_address,
        city: row.city,
        state: row.state,
        postalCode: row.postal_code,
        price: row.list_price,
        bedrooms: row.bedrooms_total,
        bathrooms: row.bathrooms_total,
        sqft: row.living_area ? Math.round(parseFloat(row.living_area)) : undefined,
        status: row.standard_status,
        propertyType: row.property_type,
        propertySubType: row.property_sub_type,
        yearBuilt: row.year_built,
        latitude: row.latitude ? parseFloat(row.latitude) : undefined,
        longitude: row.longitude ? parseFloat(row.longitude) : undefined,
        // PERFORMANCE: These fields removed from query (90% faster without JSONB extraction)
        // Use property_get_full_details tool to fetch on-demand
        photoUrl: undefined,
        // Frontend compatibility fields
        Media: [],  // Empty - images fetched on-demand
        image: undefined,
        listAgentFullName: undefined,
        listAgentMlsId: undefined,
        listOfficeName: undefined,
        listAgentEmail: undefined,
        listAgentDirectPhone: undefined,
      };
    });
}

/**
 * Search Executor Node
 *
 * Takes mappedQuery from state and executes hybrid ES + PG search
 */
export async function searchExecutorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[SearchExecutor] Starting hybrid search...');

  const mappedQuery = state.toolResults?.mappedQuery as MappedQuery | undefined;

  if (!mappedQuery) {
    console.log('[SearchExecutor] No mappedQuery in state, skipping search');
    return {
      error: 'No mapped query available',
      finalResponse: 'Search failed: Query was not parsed correctly.',
    };
  }

  try {
    const filters = convertToFilters(mappedQuery);
    console.log('[SearchExecutor] Filters:', JSON.stringify(filters, null, 2));

    // Publish progress update before searching
    const { sessionId, userId, correlationId } = state.metadata || {};
    if (sessionId) {
      await sharedPublisher.publishProgressUpdate({
        sessionId,
        userId,
        correlationId,
        status: 'Searching for matching properties...'
      });
    }

    // Stage 1: Location search
    const locStart = Date.now();
    const locationResults = await esLocationSearch(filters);
    console.log(`[SearchExecutor] ES Location: ${locationResults.size} candidates (${Date.now() - locStart}ms)`);

    // Stage 2: Features search
    const featStart = Date.now();
    const locationKeys = locationResults.size > 0 ? [...locationResults.keys()] : undefined;
    const featureResults = await esFeaturesSearch(filters, locationKeys);
    console.log(`[SearchExecutor] ES Features: ${featureResults.size} candidates (${Date.now() - featStart}ms)`);

    // Combine scores
    const combinedResults = new Map<string, number>();

    if (locationResults.size === 0 && featureResults.size === 0) {
      console.log('[SearchExecutor] No results found');
      return {
        toolResults: {
          ...state.toolResults,
          searchResults: [],
          searchStats: { total: 0, locationCount: 0, featureCount: 0 }
        },
        finalResponse: 'No properties found matching your criteria.',
      };
    }

    if (featureResults.size === 0) {
      for (const [key, score] of locationResults) combinedResults.set(key, score);
    } else if (locationResults.size === 0) {
      for (const [key, score] of featureResults) combinedResults.set(key, score);
    } else {
      for (const [key, featureScore] of featureResults) {
        const locationScore = locationResults.get(key) || 0;
        combinedResults.set(key, locationScore + featureScore);
      }
    }

    // Sort by combined score (highest first)
    const sortedEntries = [...combinedResults.entries()]
      .sort((a, b) => b[1] - a[1]);

    // Apply relevance score cutoff: filter out results that drop more than 30% from top score
    // This prevents irrelevant results like "Commodore Plaza" when searching for "Mystic Point"
    const SCORE_DROP_THRESHOLD = 0.30; // 30% drop cutoff
    const topScore = sortedEntries.length > 0 ? sortedEntries[0][1] : 0;
    const minAcceptableScore = topScore * (1 - SCORE_DROP_THRESHOLD);

    const filteredEntries = topScore > 0
      ? sortedEntries.filter(([, score]) => score >= minAcceptableScore)
      : sortedEntries;

    console.log(`[SearchExecutor] Score cutoff: top=${topScore.toFixed(2)}, min=${minAcceptableScore.toFixed(2)}, kept=${filteredEntries.length}/${sortedEntries.length}`);

    const sortedKeys = filteredEntries.map(([key]) => key);

    // Fetch full data (up to 1000 results - frontend will paginate with 50 per page)
    const fetchStart = Date.now();
    const results = await fetchProperties(sortedKeys, locationResults, featureResults, combinedResults, 1000);
    console.log(`[SearchExecutor] PG Fetch: ${results.length} results (${Date.now() - fetchStart}ms)`);

    // Build response summary (use filtered count, not total)
    const filteredCount = filteredEntries.length;
    const summaryLines = [
      `Found ${filteredCount} properties matching your criteria.`,
      '',
      `Top ${Math.min(5, results.length)} results:`
    ];

    for (let i = 0; i < Math.min(5, results.length); i++) {
      const r = results[i];
      summaryLines.push(`${i + 1}. ${r.address}, ${r.city}`);
      summaryLines.push(`   $${r.price?.toLocaleString() || 'N/A'} | ${r.bedrooms || '?'} bed | ${r.bathrooms || '?'} bath`);
    }

    if (results.length > 5) {
      summaryLines.push(`... and ${results.length - 5} more`);
    }

    return {
      toolResults: {
        ...state.toolResults,
        searchResults: results,
        searchStats: {
          total: results.length,  // Actual saved results (up to 1000)
          totalMatching: filteredCount,  // Total matching after score cutoff
          totalBeforeCutoff: combinedResults.size,  // Original total before any filtering
          displayLimit: 50,  // Frontend shows max 50 per page
          locationCount: locationResults.size,
          featureCount: featureResults.size,
          topScore: topScore,
          minAcceptableScore: minAcceptableScore,
        }
      },
      finalResponse: summaryLines.join('\n'),
    };

  } catch (error) {
    console.error('[SearchExecutor] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Search failed',
      finalResponse: 'Search failed. Please try again.',
    };
  }
}
