/**
 * Field Analyzer
 *
 * Analyzes property data to discover available fields,
 * their types, presence rates, and sample values.
 */

export interface FieldStats {
  name: string;
  type: string;
  presence: number;  // Percentage of properties that have this field (0-100)
  sample: unknown;   // Sample value from first property that has it
  uniqueValues?: number; // For low-cardinality fields
}

export interface FieldAnalysisResult {
  totalProperties: number;
  fieldsFound: number;
  fields: FieldStats[];
}

/**
 * Analyze all fields in a set of properties
 */
export function analyzeFields(
  properties: Record<string, unknown>[],
  filterPattern?: RegExp | null
): FieldStats[] {
  if (!properties || properties.length === 0) {
    return [];
  }

  // Collect all field names and their stats
  const fieldMap = new Map<string, {
    count: number;
    type: string;
    sample: unknown;
    values: Set<string>;
  }>();

  for (const property of properties) {
    for (const [key, value] of Object.entries(property)) {
      // Skip null/undefined values
      if (value === null || value === undefined) continue;

      // Apply filter if provided
      if (filterPattern && !filterPattern.test(key)) continue;

      const existing = fieldMap.get(key);
      const valueType = getValueType(value);

      if (existing) {
        existing.count++;
        // Track unique values for low-cardinality fields
        if (existing.values.size < 20 && isPrimitive(value)) {
          existing.values.add(String(value));
        }
      } else {
        fieldMap.set(key, {
          count: 1,
          type: valueType,
          sample: getSampleValue(value),
          values: new Set(isPrimitive(value) ? [String(value)] : [])
        });
      }
    }
  }

  // Convert to array and calculate presence rates
  const fields: FieldStats[] = [];
  for (const [name, stats] of fieldMap.entries()) {
    const presence = Math.round((stats.count / properties.length) * 100);

    const fieldStats: FieldStats = {
      name,
      type: stats.type,
      presence,
      sample: stats.sample
    };

    // Include unique value count for low-cardinality fields
    if (stats.values.size > 0 && stats.values.size <= 15) {
      fieldStats.uniqueValues = stats.values.size;
    }

    fields.push(fieldStats);
  }

  // Sort by presence (most common first), then by name
  fields.sort((a, b) => {
    if (b.presence !== a.presence) return b.presence - a.presence;
    return a.name.localeCompare(b.name);
  });

  return fields;
}

/**
 * Group fields by category based on naming patterns
 */
export function categorizeFields(fields: FieldStats[]): Record<string, FieldStats[]> {
  const categories: Record<string, FieldStats[]> = {
    'Identification': [],
    'Location': [],
    'Pricing': [],
    'Property Details': [],
    'Features': [],
    'Amenities': [],
    'Agent Info': [],
    'Media': [],
    'Dates': [],
    'Scores': [],
    'Other': []
  };

  const patterns: Array<{ category: string; pattern: RegExp }> = [
    { category: 'Identification', pattern: /^(ListingKey|ListingId|MlsNumber|PropertyId)/i },
    { category: 'Location', pattern: /(Address|City|State|Zip|Postal|County|Latitude|Longitude|Geo|Direction)/i },
    { category: 'Pricing', pattern: /(Price|Cost|Fee|Tax|Assessment|Value)/i },
    { category: 'Property Details', pattern: /(Bedroom|Bathroom|Sqft|Area|Room|Floor|Story|Year|Garage|Lot)/i },
    { category: 'Features', pattern: /(Feature|Style|Type|Construction|Roof|Foundation|Heating|Cooling|Appliance)/i },
    { category: 'Amenities', pattern: /(Pool|Spa|View|Water|Golf|Tennis|Gym|Security|Gated|Waterfront)/i },
    { category: 'Agent Info', pattern: /(Agent|Office|Broker|Seller|Buyer|Contact|Phone|Email)/i },
    { category: 'Media', pattern: /(Photo|Image|Media|Virtual|Tour|Video)/i },
    { category: 'Dates', pattern: /(Date|Time|Timestamp|Day|Expir|Modif|Created|Updated)/i },
    { category: 'Scores', pattern: /(Score|Rating|Rank|Quality)/i },
  ];

  for (const field of fields) {
    let categorized = false;
    for (const { category, pattern } of patterns) {
      if (pattern.test(field.name)) {
        categories[category].push(field);
        categorized = true;
        break;
      }
    }
    if (!categorized) {
      categories['Other'].push(field);
    }
  }

  // Remove empty categories
  for (const key of Object.keys(categories)) {
    if (categories[key].length === 0) {
      delete categories[key];
    }
  }

  return categories;
}

/**
 * Get common MLS field descriptions
 */
export function getFieldDescription(fieldName: string): string | null {
  const descriptions: Record<string, string> = {
    'ListingKey': 'Unique identifier for the listing',
    'ListingId': 'MLS listing number',
    'UnparsedAddress': 'Full street address',
    'City': 'City name',
    'StateOrProvince': 'State or province code',
    'PostalCode': 'ZIP or postal code',
    'ListPrice': 'Current listing price',
    'ClosePrice': 'Final sale price (if sold)',
    'BedroomsTotal': 'Total number of bedrooms',
    'BathroomsTotalInteger': 'Total number of bathrooms',
    'LivingArea': 'Living area in square feet',
    'LotSizeSquareFeet': 'Lot size in square feet',
    'YearBuilt': 'Year the property was built',
    'PropertyType': 'Type of property (Residential, Land, etc.)',
    'PropertySubType': 'Sub-type (Single Family, Condo, etc.)',
    'StandardStatus': 'Listing status (Active, Pending, Sold)',
    'Latitude': 'Geographic latitude',
    'Longitude': 'Geographic longitude',
    'PoolYN': 'Whether property has a pool (Yes/No)',
    'WaterfrontYN': 'Whether property is waterfront (Yes/No)',
    'GarageSpaces': 'Number of garage spaces',
    'ListAgentFullName': 'Listing agent name',
    'ListOfficeName': 'Listing office/brokerage name',
    'combinedScore': 'Relevance score from search (0-1)',
    'locationScore': 'Location match score (0-1)',
    'featureScore': 'Feature match score (0-1)',
  };

  return descriptions[fieldName] || null;
}

// Helper functions

function getValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';

  const type = typeof value;
  if (type === 'number') {
    return Number.isInteger(value) ? 'integer' : 'decimal';
  }
  if (type === 'string') {
    // Check if it looks like a date
    if (/^\d{4}-\d{2}-\d{2}/.test(value as string)) return 'datetime';
    // Check if it's a boolean string
    if (['true', 'false', 'yes', 'no'].includes((value as string).toLowerCase())) return 'boolean-string';
  }
  return type;
}

function isPrimitive(value: unknown): boolean {
  return value !== null &&
         typeof value !== 'object' &&
         typeof value !== 'function';
}

function getSampleValue(value: unknown): unknown {
  // For arrays, return first element or empty array indicator
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length === 1) return value[0];
    return `[${value.length} items]`;
  }

  // For objects, return key count
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    return `{${keys.length} keys}`;
  }

  // For strings, truncate if too long
  if (typeof value === 'string' && value.length > 50) {
    return value.substring(0, 47) + '...';
  }

  return value;
}
