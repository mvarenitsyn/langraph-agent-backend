/**
 * Fix Florida Coordinates Script
 *
 * One-time script to identify properties with coordinates outside Florida bounds
 * and either:
 * 1. Re-geocode if the address appears to be in Florida (contains FL, Florida)
 * 2. NULL out coordinates if the address is clearly non-Florida
 *
 * Usage:
 *   DRY_RUN=true npx tsx scripts/fix-florida-coordinates.ts   # Preview changes
 *   npx tsx scripts/fix-florida-coordinates.ts                 # Apply changes
 */

import pg from 'pg';
import fetch from 'node-fetch';

// Florida geographic bounds (with safety margin)
const FLORIDA_BOUNDS = {
  minLat: 24.0,  // Keys area
  maxLat: 31.5,  // Georgia border
  minLon: -88.0, // Pensacola area
  maxLon: -79.5, // Atlantic coast
};

// Database connection
const pool = new pg.Pool({
  host: process.env.TRESTLE_PG_HOST || process.env.PGHOST || '34.61.254.83',
  user: process.env.TRESTLE_PG_USER || process.env.PGUSER || 'postgres',
  password: process.env.TRESTLE_PG_PASSWORD || process.env.PGPASSWORD || 'C2Plq6bqGZpu23sHOOd57Ocb4',
  database: process.env.TRESTLE_PG_DATABASE || process.env.PGDATABASE || 'property_search',
  port: 5432,
});

// Geocoding configuration
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MAPBOX_API_KEY = process.env.MAPBOX_API_KEY;

interface PropertyRecord {
  listing_key: string;
  unparsed_address: string | null;
  street_number: string | null;
  street_name: string | null;
  city: string | null;
  state_or_province: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface GeocodingResult {
  latitude: number;
  longitude: number;
  provider: string;
  confidence: number;
}

// Statistics tracking
const stats = {
  total: 0,
  fixed: 0,
  nulledOut: 0,
  failedGeocode: 0,
  stillOutOfBounds: 0,
  skippedNoAddress: 0,
  errors: 0,
};

/**
 * Check if address appears to be in Florida
 */
function looksLikeFloridaAddress(property: PropertyRecord): boolean {
  const address = property.unparsed_address?.toLowerCase() || '';
  const state = property.state_or_province?.toLowerCase() || '';
  const city = property.city?.toLowerCase() || '';

  // Check state field
  if (state === 'fl' || state === 'florida') return true;

  // Check address for Florida indicators
  if (address.includes(', fl ') || address.includes(', fl,') ||
      address.includes(' fl ') || address.endsWith(' fl') ||
      address.includes('florida')) return true;

  // Common Florida cities
  const floridaCities = ['miami', 'orlando', 'tampa', 'jacksonville', 'fort lauderdale',
    'west palm beach', 'naples', 'sarasota', 'clearwater', 'st petersburg',
    'gainesville', 'tallahassee', 'pensacola', 'daytona', 'boca raton'];

  if (floridaCities.some(c => city.includes(c) || address.includes(c))) return true;

  return false;
}

/**
 * Check if coordinates are within Florida bounds
 */
function isInFlorida(lat: number, lon: number): boolean {
  return (
    lat >= FLORIDA_BOUNDS.minLat &&
    lat <= FLORIDA_BOUNDS.maxLat &&
    lon >= FLORIDA_BOUNDS.minLon &&
    lon <= FLORIDA_BOUNDS.maxLon
  );
}

/**
 * Build full address string from property fields
 */
function buildAddress(property: PropertyRecord): string | null {
  // Try unparsed_address first
  if (property.unparsed_address) {
    return property.unparsed_address;
  }

  // Build from components
  const parts = [
    property.street_number,
    property.street_name,
    property.city,
    property.state_or_province || 'FL',
    property.postal_code,
  ].filter(Boolean);

  if (parts.length < 3) {
    return null; // Not enough address info
  }

  return parts.join(', ');
}

/**
 * Geocode address using Google Maps API
 */
async function geocodeWithGoogle(address: string): Promise<GeocodingResult | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    return null;
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', GOOGLE_MAPS_API_KEY);

  try {
    const response = await fetch(url.toString());
    const data = (await response.json()) as any;

    if (data.status === 'OK' && data.results?.length > 0) {
      const result = data.results[0];
      const location = result.geometry?.location;

      if (location?.lat && location?.lng) {
        return {
          latitude: location.lat,
          longitude: location.lng,
          provider: 'google',
          confidence: result.geometry?.location_type === 'ROOFTOP' ? 0.9 : 0.7,
        };
      }
    }

    return null;
  } catch (error) {
    console.error(`  Google geocoding error:`, error);
    return null;
  }
}

/**
 * Geocode address using Mapbox API
 */
async function geocodeWithMapbox(address: string): Promise<GeocodingResult | null> {
  if (!MAPBOX_API_KEY) {
    return null;
  }

  const query = encodeURIComponent(address);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_API_KEY}&limit=1`;

  try {
    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.features?.length > 0) {
      const feature = data.features[0];
      const [lng, lat] = feature.center;

      return {
        latitude: lat,
        longitude: lng,
        provider: 'mapbox',
        confidence: feature.relevance || 0.6,
      };
    }

    return null;
  } catch (error) {
    console.error(`  Mapbox geocoding error:`, error);
    return null;
  }
}

/**
 * Geocode address using Nominatim (free, no API key)
 */
async function geocodeWithNominatim(address: string): Promise<GeocodingResult | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  try {
    // Rate limiting for Nominatim (1 request per second)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Florida-Coordinate-Fix-Script/1.0' },
    });
    const data = (await response.json()) as any[];

    if (data?.length > 0) {
      const result = data[0];

      return {
        latitude: parseFloat(result.lat),
        longitude: parseFloat(result.lon),
        provider: 'nominatim',
        confidence: 0.5,
      };
    }

    return null;
  } catch (error) {
    console.error(`  Nominatim geocoding error:`, error);
    return null;
  }
}

/**
 * Try all geocoding providers in order
 */
async function geocodeAddress(address: string): Promise<GeocodingResult | null> {
  // Try Google first (most accurate)
  let result = await geocodeWithGoogle(address);
  if (result) return result;

  // Try Mapbox as fallback
  result = await geocodeWithMapbox(address);
  if (result) return result;

  // Try Nominatim as last resort (free)
  result = await geocodeWithNominatim(address);
  if (result) return result;

  return null;
}

/**
 * Update property coordinates in database
 */
async function updateCoordinates(
  listingKey: string,
  latitude: number,
  longitude: number,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would update coordinates to (${latitude}, ${longitude})`);
    return true;
  }

  try {
    await pool.query(
      `UPDATE trestle_properties
       SET latitude = $1, longitude = $2, updated_at = NOW()
       WHERE listing_key = $3`,
      [latitude, longitude, listingKey]
    );
    return true;
  } catch (error) {
    console.error(`  Database update error:`, error);
    return false;
  }
}

/**
 * NULL out property coordinates (for non-Florida properties)
 */
async function nullOutCoordinates(
  listingKey: string,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would NULL out coordinates`);
    return true;
  }

  try {
    await pool.query(
      `UPDATE trestle_properties
       SET latitude = NULL, longitude = NULL, updated_at = NOW()
       WHERE listing_key = $1`,
      [listingKey]
    );
    return true;
  } catch (error) {
    console.error(`  Database update error:`, error);
    return false;
  }
}

/**
 * Main script execution
 */
async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === 'true';

  console.log('='.repeat(60));
  console.log('Florida Coordinate Fix Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will update database)'}`);
  console.log(`Florida bounds: lat ${FLORIDA_BOUNDS.minLat}-${FLORIDA_BOUNDS.maxLat}, lng ${FLORIDA_BOUNDS.minLon}-${FLORIDA_BOUNDS.maxLon}`);
  console.log(`Google Maps API: ${GOOGLE_MAPS_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`Mapbox API: ${MAPBOX_API_KEY ? 'configured' : 'NOT configured'}`);
  console.log('');

  // Find properties outside Florida bounds
  console.log('Finding properties with coordinates outside Florida...');

  const query = `
    SELECT
      listing_key,
      unparsed_address,
      street_number,
      street_name,
      city,
      state_or_province,
      postal_code,
      latitude,
      longitude
    FROM trestle_properties
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND (
        latitude < $1 OR latitude > $2 OR
        longitude < $3 OR longitude > $4
      )
    ORDER BY listing_key
  `;

  const result = await pool.query<PropertyRecord>(query, [
    FLORIDA_BOUNDS.minLat,
    FLORIDA_BOUNDS.maxLat,
    FLORIDA_BOUNDS.minLon,
    FLORIDA_BOUNDS.maxLon,
  ]);

  const properties = result.rows;
  stats.total = properties.length;

  console.log(`Found: ${stats.total} properties with bad coordinates\n`);

  if (stats.total === 0) {
    console.log('No properties need fixing. Exiting.');
    await pool.end();
    return;
  }

  // Process each property
  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    const progress = `[${i + 1}/${stats.total}]`;

    console.log(`${progress} Processing: ${property.listing_key}`);
    console.log(`  Address: ${property.unparsed_address || 'N/A'}`);
    console.log(`  Current: (${property.latitude}, ${property.longitude})`);

    // Check if this looks like a Florida address
    const isFloridaAddress = looksLikeFloridaAddress(property);
    console.log(`  Florida address: ${isFloridaAddress ? 'YES' : 'NO'}`);

    // If not a Florida address, NULL out coordinates
    if (!isFloridaAddress) {
      const nulled = await nullOutCoordinates(property.listing_key, dryRun);
      if (nulled) {
        console.log(`  Status: NULLED (non-Florida property)`);
        stats.nulledOut++;
      } else {
        console.log(`  Status: ERROR (database update failed)`);
        stats.errors++;
      }
      continue;
    }

    // Build address for geocoding
    const address = buildAddress(property);
    if (!address) {
      console.log(`  Status: SKIPPED (no address available)`);
      stats.skippedNoAddress++;
      continue;
    }

    console.log(`  Geocoding: ${address}`);

    // Geocode the address
    const geocoded = await geocodeAddress(address);

    if (!geocoded) {
      console.log(`  Status: FAILED (geocoding returned no results)`);
      stats.failedGeocode++;
      continue;
    }

    console.log(`  New coords: (${geocoded.latitude}, ${geocoded.longitude}) via ${geocoded.provider}`);

    // Validate new coordinates are in Florida
    if (!isInFlorida(geocoded.latitude, geocoded.longitude)) {
      // Even if geocoding fails, NULL out the bad coordinates
      const nulled = await nullOutCoordinates(property.listing_key, dryRun);
      if (nulled) {
        console.log(`  Status: NULLED (geocoding returned non-Florida coords)`);
        stats.nulledOut++;
      } else {
        console.log(`  Status: ERROR (database update failed)`);
        stats.errors++;
      }
      continue;
    }

    // Update database with new coordinates
    const updated = await updateCoordinates(
      property.listing_key,
      geocoded.latitude,
      geocoded.longitude,
      dryRun
    );

    if (updated) {
      console.log(`  Status: FIXED`);
      stats.fixed++;
    } else {
      console.log(`  Status: ERROR (database update failed)`);
      stats.errors++;
    }

    // Rate limiting between properties
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total found:          ${stats.total}`);
  console.log(`Fixed (re-geocoded):  ${stats.fixed}`);
  console.log(`Nulled out:           ${stats.nulledOut}`);
  console.log(`Failed to geocode:    ${stats.failedGeocode}`);
  console.log(`Skipped (no address): ${stats.skippedNoAddress}`);
  console.log(`Errors:               ${stats.errors}`);
  console.log('');

  if (dryRun) {
    console.log('This was a DRY RUN. To apply changes, run without DRY_RUN=true');
  } else {
    console.log('Changes have been applied to the database.');
  }

  await pool.end();
}

// Run the script
main().catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
