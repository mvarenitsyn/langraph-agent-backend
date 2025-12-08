import { Pool } from 'pg';
import { SearchResult } from '../../../nodes/search-executor.js';

// Use the property_search database for search results persistence
const pool = new Pool({
  host: process.env.TRESTLE_PG_HOST || '34.61.254.83',
  port: 5432,
  database: 'property_search',
  user: 'postgres',
  password: process.env.TRESTLE_PG_PASSWORD || 'C2Plq6bqGZpu23sHOOd57Ocb4'
});

export interface SaveSearchParams {
  threadId: string;
  userId?: string;
  queryText: string;
  mappedQuery: Record<string, unknown>;
  results: SearchResult[];
  duplicatesRemoved: number;
}

export interface SearchSummary {
  total: number;
  duplicatesRemoved: number;
  topCities: string[];
  priceRange: { min: number | null; max: number | null };
  bedroomRange: { min: number | null; max: number | null };
}

export interface GetResultsParams {
  searchId: string;
  sortBy?: 'price' | 'bedrooms' | 'sqft' | 'combined_score' | 'year_built';
  sortOrder?: 'asc' | 'desc';
  filters?: {
    minPrice?: number;
    maxPrice?: number;
    minBeds?: number;
    maxBeds?: number;
    cities?: string[];
    status?: string[];
  };
  page?: number;
  pageSize?: number;
  includeFiltered?: boolean; // true = show all results, false = show only non-filtered results (default)
}

export interface PageInfo {
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
}

/**
 * Save search results to database
 * Returns searchId and summary
 */
export async function saveSearchResults(params: SaveSearchParams): Promise<{ searchId: string; summary: SearchSummary }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insert main search record
    const searchResult = await client.query<{ search_id: string }>(
      `INSERT INTO search_results (thread_id, user_id, query_text, mapped_query, total_results, duplicates_removed)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING search_id`,
      [
        params.threadId,
        params.userId || null,
        params.queryText,
        JSON.stringify(params.mappedQuery),
        params.results.length,
        params.duplicatesRemoved
      ]
    );

    const searchId = searchResult.rows[0].search_id;

    // Batch insert result items
    if (params.results.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      params.results.forEach((result, index) => {
        const offset = index * 16;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16})`
        );

        // Extended result with dedup info
        const extResult = result as SearchResult & { duplicateCount?: number; alternateTypes?: string[] };

        // Parse numeric values that may come as strings
        const parseDecimal = (val: unknown): number | null => {
          if (val === null || val === undefined) return null;
          const num = parseFloat(String(val));
          return isNaN(num) ? null : num;
        };
        const parseInt2 = (val: unknown): number | null => {
          if (val === null || val === undefined) return null;
          const num = parseInt(String(val), 10);
          return isNaN(num) ? null : num;
        };

        values.push(
          searchId,
          result.listingKey,
          index + 1, // rank
          parseDecimal(result.price),
          parseInt2(result.bedrooms),
          parseDecimal(result.bathrooms),
          parseInt2(result.sqft),
          parseInt2(result.yearBuilt),
          result.city || null,
          result.status || null,
          result.locationScore,
          result.featureScore,
          result.combinedScore,
          JSON.stringify(result),
          extResult.duplicateCount || 1,
          extResult.alternateTypes || null
        );
      });

      await client.query(
        `INSERT INTO search_result_items
         (search_id, listing_key, rank, price, bedrooms, bathrooms, sqft, year_built, city, status, location_score, feature_score, combined_score, property_data, duplicate_count, alternate_types)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    await client.query('COMMIT');

    // Calculate summary
    const summary = calculateSummary(params.results, params.duplicatesRemoved);

    return { searchId, summary };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get search results with sorting, filtering, and pagination
 */
export async function getSearchResults(params: GetResultsParams): Promise<{ results: SearchResult[]; pageInfo: PageInfo }> {
  const {
    searchId,
    sortBy = 'combined_score',
    sortOrder = 'desc',
    filters = {},
    page = 1,
    pageSize = 20,
    includeFiltered = false // Default: only show non-filtered results
  } = params;

  // Build WHERE clause
  const conditions: string[] = ['search_id = $1'];
  const values: unknown[] = [searchId];
  let paramIndex = 2;

  // By default, exclude filtered-out results unless explicitly requested
  if (!includeFiltered) {
    conditions.push('is_filtered_out = false');
  }

  if (filters.minPrice !== undefined) {
    conditions.push(`price >= $${paramIndex++}`);
    values.push(filters.minPrice);
  }
  if (filters.maxPrice !== undefined) {
    conditions.push(`price <= $${paramIndex++}`);
    values.push(filters.maxPrice);
  }
  if (filters.minBeds !== undefined) {
    conditions.push(`bedrooms >= $${paramIndex++}`);
    values.push(filters.minBeds);
  }
  if (filters.maxBeds !== undefined) {
    conditions.push(`bedrooms <= $${paramIndex++}`);
    values.push(filters.maxBeds);
  }
  if (filters.cities?.length) {
    conditions.push(`city = ANY($${paramIndex++})`);
    values.push(filters.cities);
  }
  if (filters.status?.length) {
    conditions.push(`status = ANY($${paramIndex++})`);
    values.push(filters.status);
  }

  const whereClause = conditions.join(' AND ');

  // Map sortBy to column name
  const sortColumn = sortBy === 'combined_score' ? 'combined_score' : sortBy;
  const orderDirection = sortOrder.toUpperCase();

  // Get total count
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM search_result_items WHERE ${whereClause}`,
    values
  );
  const totalItems = parseInt(countResult.rows[0].count, 10);
  const totalPages = Math.ceil(totalItems / pageSize);

  // Get paginated results
  const offset = (page - 1) * pageSize;
  const resultsQuery = await pool.query<{ property_data: SearchResult }>(
    `SELECT property_data FROM search_result_items
     WHERE ${whereClause}
     ORDER BY ${sortColumn} ${orderDirection} NULLS LAST
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...values, pageSize, offset]
  );

  const results = resultsQuery.rows.map(row => row.property_data);

  return {
    results,
    pageInfo: {
      page,
      pageSize,
      totalPages,
      totalItems
    }
  };
}

/**
 * Get search metadata
 */
export async function getSearchMetadata(searchId: string): Promise<{
  queryText: string;
  mappedQuery: Record<string, unknown>;
  totalResults: number;
  createdAt: Date;
} | null> {
  const result = await pool.query(
    `SELECT query_text, mapped_query, total_results, created_at
     FROM search_results WHERE search_id = $1`,
    [searchId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    queryText: row.query_text,
    mappedQuery: row.mapped_query,
    totalResults: row.total_results,
    createdAt: row.created_at
  };
}

/**
 * Delete search results
 */
export async function deleteSearchResults(searchId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM search_results WHERE search_id = $1',
    [searchId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark properties as filtered out based on filter criteria.
 * First resets all to not filtered, then marks properties that DON'T match filters as filtered out.
 * This persists the filter state so shared links show filtered results.
 */
export async function markFilteredOut(
  searchId: string,
  filters: {
    minPrice?: number;
    maxPrice?: number;
    minBeds?: number;
    maxBeds?: number;
    cities?: string[];
    status?: string[];
  }
): Promise<{ filteredCount: number; totalCount: number }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 1: Reset all to not filtered
    await client.query(
      'UPDATE search_result_items SET is_filtered_out = false WHERE search_id = $1',
      [searchId]
    );

    // Step 2: Build exclusion conditions (properties that DON'T match filters)
    const excludeConditions: string[] = [];
    const params: unknown[] = [searchId];
    let paramIndex = 2;

    // Exclude properties OUTSIDE the filter range
    if (filters.minPrice !== undefined) {
      excludeConditions.push(`(price IS NULL OR price < $${paramIndex++})`);
      params.push(filters.minPrice);
    }
    if (filters.maxPrice !== undefined) {
      excludeConditions.push(`(price IS NULL OR price > $${paramIndex++})`);
      params.push(filters.maxPrice);
    }
    if (filters.minBeds !== undefined) {
      excludeConditions.push(`(bedrooms IS NULL OR bedrooms < $${paramIndex++})`);
      params.push(filters.minBeds);
    }
    if (filters.maxBeds !== undefined) {
      excludeConditions.push(`(bedrooms IS NULL OR bedrooms > $${paramIndex++})`);
      params.push(filters.maxBeds);
    }
    if (filters.cities && filters.cities.length > 0) {
      excludeConditions.push(`(city IS NULL OR city != ALL($${paramIndex++}))`);
      params.push(filters.cities);
    }
    if (filters.status && filters.status.length > 0) {
      excludeConditions.push(`(status IS NULL OR status != ALL($${paramIndex++}))`);
      params.push(filters.status);
    }

    // Step 3: Mark excluded properties as filtered out
    if (excludeConditions.length > 0) {
      const excludeQuery = `
        UPDATE search_result_items
        SET is_filtered_out = true
        WHERE search_id = $1 AND (${excludeConditions.join(' OR ')})
      `;
      await client.query(excludeQuery, params);
    }

    await client.query('COMMIT');

    // Step 4: Get counts
    const countResult = await pool.query<{ filtered_count: string; total_count: string }>(`
      SELECT
        COUNT(*) FILTER (WHERE is_filtered_out = false) as filtered_count,
        COUNT(*) as total_count
      FROM search_result_items
      WHERE search_id = $1
    `, [searchId]);

    const filteredCount = parseInt(countResult.rows[0].filtered_count, 10);
    const totalCount = parseInt(countResult.rows[0].total_count, 10);

    console.log(`[SearchResultsDB] markFilteredOut: ${filteredCount} of ${totalCount} properties match filters`);

    return { filteredCount, totalCount };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reset all filters for a search (mark all properties as not filtered).
 * Call this when user clicks "Reset Filters".
 */
export async function resetFilters(searchId: string): Promise<{ count: number }> {
  const result = await pool.query(
    'UPDATE search_result_items SET is_filtered_out = false WHERE search_id = $1',
    [searchId]
  );
  const count = result.rowCount ?? 0;
  console.log(`[SearchResultsDB] resetFilters: Reset ${count} properties for searchId ${searchId}`);
  return { count };
}

/**
 * Get a single property by listing key from a search
 * Efficient direct lookup using indexed listing_key column
 * Now includes listing agent info from trestle_properties
 */
export async function getPropertyByListingKey(
  searchId: string,
  listingKey: string
): Promise<SearchResult | null> {
  const result = await pool.query(
    `SELECT
      sri.property_data,
      tp.raw_data->>'ListAgentFullName' as list_agent_full_name,
      tp.raw_data->>'ListAgentMlsId' as list_agent_mls_id,
      tp.raw_data->>'ListOfficeName' as list_office_name,
      tp.raw_data->>'ListAgentEmail' as list_agent_email,
      tp.raw_data->>'ListAgentDirectPhone' as list_agent_direct_phone
    FROM search_result_items sri
    LEFT JOIN trestle_properties tp ON sri.listing_key = tp.listing_key
    WHERE sri.search_id = $1 AND sri.listing_key = $2`,
    [searchId, listingKey]
  );

  if (!result.rows[0]) return null;

  const row = result.rows[0];
  const property = row.property_data as SearchResult;

  // Merge agent info into property object
  return {
    ...property,
    listAgentFullName: row.list_agent_full_name,
    listAgentMlsId: row.list_agent_mls_id,
    listOfficeName: row.list_office_name,
    listAgentEmail: row.list_agent_email,
    listAgentDirectPhone: row.list_agent_direct_phone,
  };
}

/**
 * Calculate summary statistics from results
 */
function calculateSummary(results: SearchResult[], duplicatesRemoved: number): SearchSummary {
  if (results.length === 0) {
    return {
      total: 0,
      duplicatesRemoved,
      topCities: [],
      priceRange: { min: null, max: null },
      bedroomRange: { min: null, max: null }
    };
  }

  // Count cities
  const cityCounts = new Map<string, number>();
  let minPrice: number | null = null;
  let maxPrice: number | null = null;
  let minBeds: number | null = null;
  let maxBeds: number | null = null;

  for (const result of results) {
    // City counts
    if (result.city) {
      cityCounts.set(result.city, (cityCounts.get(result.city) || 0) + 1);
    }

    // Price range
    if (result.price !== undefined && result.price !== null) {
      if (minPrice === null || result.price < minPrice) minPrice = result.price;
      if (maxPrice === null || result.price > maxPrice) maxPrice = result.price;
    }

    // Bedroom range
    if (result.bedrooms !== undefined && result.bedrooms !== null) {
      if (minBeds === null || result.bedrooms < minBeds) minBeds = result.bedrooms;
      if (maxBeds === null || result.bedrooms > maxBeds) maxBeds = result.bedrooms;
    }
  }

  // Get top 5 cities
  const topCities = [...cityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([city]) => city);

  return {
    total: results.length,
    duplicatesRemoved,
    topCities,
    priceRange: { min: minPrice, max: maxPrice },
    bedroomRange: { min: minBeds, max: maxBeds }
  };
}

/**
 * Initialize database tables (run setup.sql)
 */
export async function initializeSearchResultsTables(): Promise<void> {
  const client = await pool.connect();
  try {
    // Enable pgcrypto extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS search_results (
        search_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        thread_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        query_text TEXT NOT NULL,
        mapped_query JSONB NOT NULL,
        total_results INTEGER NOT NULL,
        duplicates_removed INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS search_result_items (
        id SERIAL PRIMARY KEY,
        search_id UUID NOT NULL REFERENCES search_results(search_id) ON DELETE CASCADE,
        listing_key VARCHAR(50) NOT NULL,
        rank INTEGER NOT NULL,
        price DECIMAL(12,2),
        bedrooms INTEGER,
        bathrooms DECIMAL(4,1),
        sqft INTEGER,
        year_built INTEGER,
        city VARCHAR(100),
        status VARCHAR(50),
        location_score DECIMAL(10,4),
        feature_score DECIMAL(10,4),
        combined_score DECIMAL(10,4),
        property_data JSONB NOT NULL,
        duplicate_count INTEGER DEFAULT 1,
        alternate_types TEXT[],
        is_filtered_out BOOLEAN DEFAULT false
      )
    `);

    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_results_thread_id ON search_results(thread_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_search_id ON search_result_items(search_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_price ON search_result_items(search_id, price)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_bedrooms ON search_result_items(search_id, bedrooms)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_combined_score ON search_result_items(search_id, combined_score DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_filtered ON search_result_items(search_id, is_filtered_out)');

    console.log('[SearchResultsDB] Tables initialized successfully');
  } finally {
    client.release();
  }
}
