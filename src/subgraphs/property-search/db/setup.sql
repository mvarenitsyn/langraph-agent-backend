-- Search Results Persistence Schema
-- Run this against the checkpoints database

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Main search results table (one row per search)
CREATE TABLE IF NOT EXISTS search_results (
    search_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255),
    query_text TEXT NOT NULL,
    mapped_query JSONB NOT NULL,
    total_results INTEGER NOT NULL,
    duplicates_removed INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for search_results
CREATE INDEX IF NOT EXISTS idx_search_results_thread_id ON search_results(thread_id);
CREATE INDEX IF NOT EXISTS idx_search_results_user_id ON search_results(user_id);
CREATE INDEX IF NOT EXISTS idx_search_results_created_at ON search_results(created_at);

-- Individual result items (one row per property)
CREATE TABLE IF NOT EXISTS search_result_items (
    id SERIAL PRIMARY KEY,
    search_id UUID NOT NULL REFERENCES search_results(search_id) ON DELETE CASCADE,
    listing_key VARCHAR(50) NOT NULL,
    rank INTEGER NOT NULL,

    -- Sortable fields (denormalized for efficient queries)
    price DECIMAL(12,2),
    bedrooms INTEGER,
    bathrooms DECIMAL(4,1),
    sqft INTEGER,
    year_built INTEGER,
    city VARCHAR(100),
    status VARCHAR(50),

    -- Scores
    location_score DECIMAL(10,4),
    feature_score DECIMAL(10,4),
    combined_score DECIMAL(10,4),

    -- Full property data (JSONB for flexibility)
    property_data JSONB NOT NULL,

    -- Deduplication info
    duplicate_count INTEGER DEFAULT 1,
    alternate_types TEXT[],

    -- Filter persistence (for shareable filtered results)
    is_filtered_out BOOLEAN DEFAULT false
);

-- Indexes for search_result_items
CREATE INDEX IF NOT EXISTS idx_search_result_items_search_id ON search_result_items(search_id);
CREATE INDEX IF NOT EXISTS idx_search_result_items_price ON search_result_items(search_id, price);
CREATE INDEX IF NOT EXISTS idx_search_result_items_bedrooms ON search_result_items(search_id, bedrooms);
CREATE INDEX IF NOT EXISTS idx_search_result_items_sqft ON search_result_items(search_id, sqft);
CREATE INDEX IF NOT EXISTS idx_search_result_items_combined_score ON search_result_items(search_id, combined_score DESC);
CREATE INDEX IF NOT EXISTS idx_search_result_items_city ON search_result_items(search_id, city);
CREATE INDEX IF NOT EXISTS idx_search_result_items_filtered ON search_result_items(search_id, is_filtered_out);

-- Function to delete old search results (optional cleanup)
CREATE OR REPLACE FUNCTION cleanup_old_search_results(days_old INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM search_results
    WHERE created_at < NOW() - (days_old || ' days')::INTERVAL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
