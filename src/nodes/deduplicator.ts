import { AgentStateType } from '../types/state.js';
import { SearchResult } from './search-executor.js';
import { sharedPublisher } from '../pubsub/shared.js';

/**
 * Deduplication Priority:
 * 1. Active listings first (status = 'Active')
 * 2. Sales over rentals (propertyType = 'Residential' > 'ResidentialLease')
 * 3. Higher combined score
 * 4. Higher listing key (typically newer)
 */

interface DeduplicatedResult extends SearchResult {
  /** When duplicates exist, shows types like "Condo, Townhouse" */
  alternateTypes?: string[];
  /** Number of duplicate listings at this address */
  duplicateCount?: number;
}

/**
 * Calculates priority score for a listing
 * Higher score = higher priority
 */
function calculatePriority(result: SearchResult): number {
  let score = 0;

  // Priority 1: Active listings (+1000)
  if (result.status === 'Active') {
    score += 1000;
  } else if (result.status === 'Pending') {
    score += 500;
  }
  // Closed listings get 0

  // Priority 2: Sales over rentals (+100)
  if (result.propertyType === 'Residential') {
    score += 100;
  } else if (result.propertyType === 'ResidentialLease') {
    score += 50;
  }

  // Priority 3: Combined search score (0-10 normalized)
  score += Math.min(result.combinedScore / 10, 10);

  // Priority 4: Listing key as tiebreaker (higher = newer, assuming sequential)
  // Parse numeric part of listing key for comparison
  const keyNum = parseInt(result.listingKey.replace(/\D/g, ''), 10) || 0;
  score += keyNum / 1e12; // Very small contribution, just for tiebreaking

  return score;
}

/**
 * Normalizes address for comparison
 * Removes unit numbers, extra spaces, and standardizes format
 */
function normalizeAddress(address: string | undefined): string {
  if (!address) return '';

  return address
    .toLowerCase()
    .replace(/\s+(apt|unit|#|ste|suite|fl|floor)\s*\S*/gi, '') // Remove unit numbers
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
}

/**
 * Deduplicator Node
 *
 * Removes duplicate listings for the same address:
 * - Groups by normalized address
 * - Picks best listing based on priority (Active > Pending > Closed, Sales > Rentals)
 * - Attaches alternate property types for user reference
 */
export async function deduplicatorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Deduplicator] Processing search results...');

  // Publish progress update
  const { sessionId, userId, correlationId } = state.metadata || {};
  if (sessionId) {
    await sharedPublisher.publishProgressUpdate({
      sessionId,
      userId,
      correlationId,
      status: 'Removing duplicate properties...'
    });
  }

  const searchResults = state.toolResults?.searchResults as SearchResult[] | undefined;

  if (!searchResults || searchResults.length === 0) {
    console.log('[Deduplicator] No results to deduplicate');
    return {};
  }

  // Group results by normalized address + city
  const addressGroups = new Map<string, SearchResult[]>();

  for (const result of searchResults) {
    const normalizedAddr = normalizeAddress(result.address);
    const city = (result.city || '').toLowerCase().trim();
    const key = `${normalizedAddr}|${city}`;

    if (!addressGroups.has(key)) {
      addressGroups.set(key, []);
    }
    addressGroups.get(key)!.push(result);
  }

  console.log(`[Deduplicator] Found ${addressGroups.size} unique addresses from ${searchResults.length} listings`);

  // Process each group and pick the best listing
  const deduplicatedResults: DeduplicatedResult[] = [];

  for (const [addressKey, group] of addressGroups) {
    if (group.length === 1) {
      // No duplicates, keep as-is
      deduplicatedResults.push(group[0]);
    } else {
      // Sort by priority (highest first)
      group.sort((a, b) => calculatePriority(b) - calculatePriority(a));

      // Pick the best one
      const best = group[0];

      // Collect alternate property types (excluding the best one's type)
      const alternateTypes = [...new Set(
        group
          .slice(1)
          .map(r => r.propertySubType)
          .filter((t): t is string => !!t && t !== best.propertySubType)
      )];

      const deduped: DeduplicatedResult = {
        ...best,
        duplicateCount: group.length,
      };

      if (alternateTypes.length > 0) {
        deduped.alternateTypes = alternateTypes;
      }

      console.log(`[Deduplicator] Address "${best.address}" has ${group.length} listings, picked ${best.status} ${best.propertyType}`);

      deduplicatedResults.push(deduped);
    }
  }

  // Sort by combined score (maintain relevance ordering)
  deduplicatedResults.sort((a, b) => b.combinedScore - a.combinedScore);

  console.log(`[Deduplicator] Reduced from ${searchResults.length} to ${deduplicatedResults.length} unique listings`);

  // Update response summary
  const duplicatesRemoved = searchResults.length - deduplicatedResults.length;
  const summaryLines = [
    `Found ${deduplicatedResults.length} unique properties${duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicates removed)` : ''}.`,
    '',
    `Top ${Math.min(5, deduplicatedResults.length)} results:`
  ];

  for (let i = 0; i < Math.min(5, deduplicatedResults.length); i++) {
    const r = deduplicatedResults[i];
    let line = `${i + 1}. ${r.address}, ${r.city}`;
    if (r.duplicateCount && r.duplicateCount > 1) {
      line += ` (${r.duplicateCount} listings)`;
    }
    summaryLines.push(line);

    let details = `   $${r.price?.toLocaleString() || 'N/A'} | ${r.bedrooms || '?'} bed | ${r.bathrooms || '?'} bath`;
    if (r.propertySubType) {
      details += ` | ${r.propertySubType}`;
    }
    if (r.alternateTypes?.length) {
      details += ` (also: ${r.alternateTypes.join(', ')})`;
    }
    summaryLines.push(details);
  }

  if (deduplicatedResults.length > 5) {
    summaryLines.push(`... and ${deduplicatedResults.length - 5} more`);
  }

  return {
    toolResults: {
      ...state.toolResults,
      searchResults: deduplicatedResults,
      searchStats: {
        ...state.toolResults?.searchStats,
        totalBeforeDedup: searchResults.length,
        totalAfterDedup: deduplicatedResults.length,
        duplicatesRemoved,
      }
    },
    finalResponse: summaryLines.join('\n'),
  };
}
