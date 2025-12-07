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
    pageSize = 20
  } = params;

  // Build WHERE clause
  const conditions: string[] = ['search_id = $1'];
  const values: unknown[] = [searchId];
  let paramIndex = 2;

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
 * Get a single property by listing key from a search
 * Efficient direct lookup using indexed listing_key column
 */
export async function getPropertyByListingKey(
  searchId: string,
  listingKey: string
): Promise<SearchResult | null> {
  const result = await pool.query<{ property_data: SearchResult }>(
    `SELECT property_data FROM search_result_items
     WHERE search_id = $1 AND listing_key = $2`,
    [searchId, listingKey]
  );
  return result.rows[0]?.property_data || null;
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
        alternate_types TEXT[]
      )
    `);

    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_results_thread_id ON search_results(thread_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_search_id ON search_result_items(search_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_price ON search_result_items(search_id, price)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_bedrooms ON search_result_items(search_id, bedrooms)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_search_result_items_combined_score ON search_result_items(search_id, combined_score DESC)');

    console.log('[SearchResultsDB] Tables initialized successfully');
  } finally {
    client.release();
  }
}
