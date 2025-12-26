/**
 * MappedQuery Output Schema
 *
 * This schema defines the output format from the query-mapper node.
 * It's compatible with the hybrid-search script in trestle-sync-cli.
 *
 * Usage with hybrid-search script:
 * ```bash
 * npx ts-node scripts/hybrid-search.ts --json '{
 *   "location": { "query": "Miami Beach", "cities": ["Miami Beach"] },
 *   "features": { "query": "ocean view" },
 *   "strict": { "minBeds": 3, "maxPrice": 800000 }
 * }'
 * ```
 */

export interface MappedQueryLocation {
  /** Full location text: neighborhoods, areas, streets, building names */
  query: string;
  /** City names for strict filtering, e.g. ["Miami Beach", "Aventura"] */
  cities: string[] | null;
  /** ZIP codes for strict filtering, e.g. ["33139", "33180"] */
  postalCodes: string[] | null;
  /** County names for strict filtering */
  counties: string[] | null;
}

export interface MappedQueryFeatures {
  /** Feature text for ES features index: pool, ocean view, waterfront, renovated, etc. */
  query: string;
}

export interface MappedQueryStrict {
  // Term filters (exact match)
  /** Property type: Residential, ResidentialLease, Land, CommercialSale, etc. */
  propertyType: string[] | null;
  /** Property subtype (single value): Condominium, SingleFamilyResidence, Townhouse, Apartment, etc. */
  propertySubType: string | null;
  /** Listing status (single value): Active, Pending, Closed */
  status: string | null;

  // Range filters
  /** Minimum bedrooms */
  minBeds: number | null;
  /** Maximum bedrooms */
  maxBeds: number | null;
  /** Minimum bathrooms */
  minBaths: number | null;
  /** Maximum bathrooms */
  maxBaths: number | null;
  /** Minimum price in dollars */
  minPrice: number | null;
  /** Maximum price in dollars */
  maxPrice: number | null;
  /** Minimum square feet */
  minSqft: number | null;
  /** Maximum square feet */
  maxSqft: number | null;
  /** Minimum year built */
  minYearBuilt: number | null;
  /** Maximum year built */
  maxYearBuilt: number | null;

  // Boolean filters
  /** Has private pool */
  poolYn: boolean | null;
  /** Is waterfront property */
  waterfrontYn: boolean | null;
  /** Has garage */
  garageYn: boolean | null;
  /** Is new construction */
  newConstructionYn: boolean | null;
  /** Is 55+ senior/active adult community */
  seniorCommunityYn: boolean | null;

  // Array filters
  /** View types: Ocean, Bay, Intracoastal, Canal, Lake, Golf, City, Garden, Pool */
  viewTypes: string[] | null;
}

export interface MappedQuery {
  /** Location search → ES properties_location index */
  location: MappedQueryLocation;
  /** Features search → ES properties_features index */
  features: MappedQueryFeatures;
  /** Strict filters → ES term/range/boolean filters */
  strict: MappedQueryStrict;
  /** Visual/aesthetic attributes for VECTOR similarity search */
  visual_features: string;
  /** Anything else that doesn't fit above */
  other: string;
}

/**
 * JSON Schema for MappedQuery (for external tools)
 */
export const MappedQueryJsonSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "location": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
        "cities": { "type": ["array", "null"], "items": { "type": "string" } },
        "postalCodes": { "type": ["array", "null"], "items": { "type": "string" } },
        "counties": { "type": ["array", "null"], "items": { "type": "string" } }
      },
      "required": ["query"]
    },
    "features": {
      "type": "object",
      "properties": {
        "query": { "type": "string" }
      },
      "required": ["query"]
    },
    "strict": {
      "type": "object",
      "properties": {
        "propertyType": {
          "type": ["array", "null"],
          "items": {
            "type": "string",
            "enum": ["Residential", "ResidentialLease", "Land", "CommercialLease", "ResidentialIncome", "CommercialSale", "BusinessOpportunity"]
          }
        },
        "propertySubType": {
          "type": ["string", "null"],
          "enum": ["Condominium", "SingleFamilyResidence", "Townhouse", "Apartment", "MultiFamily", "Residential", "Villa", "Office", "Duplex", "Industrial", "StockCooperative", "Retail", "MobileHome", "Other", "MixedUse", "Quadruplex", "Commercial", "Triplex", "BoatSlip", "Business", "HotelMotel", "SpecialPurpose", "UnimprovedLand", null]
        },
        "status": {
          "type": ["string", "null"],
          "enum": ["Active", "Pending", "Closed", null]
        },
        "minBeds": { "type": ["number", "null"] },
        "maxBeds": { "type": ["number", "null"] },
        "minBaths": { "type": ["number", "null"] },
        "maxBaths": { "type": ["number", "null"] },
        "minPrice": { "type": ["number", "null"] },
        "maxPrice": { "type": ["number", "null"] },
        "minSqft": { "type": ["number", "null"] },
        "maxSqft": { "type": ["number", "null"] },
        "minYearBuilt": { "type": ["number", "null"] },
        "maxYearBuilt": { "type": ["number", "null"] },
        "poolYn": { "type": ["boolean", "null"] },
        "waterfrontYn": { "type": ["boolean", "null"] },
        "garageYn": { "type": ["boolean", "null"] },
        "newConstructionYn": { "type": ["boolean", "null"] },
        "seniorCommunityYn": { "type": ["boolean", "null"] },
        "viewTypes": { "type": ["array", "null"], "items": { "type": "string" } }
      }
    },
    "visual_features": { "type": "string" },
    "other": { "type": "string" }
  },
  "required": ["location", "features", "strict", "visual_features", "other"]
} as const;
