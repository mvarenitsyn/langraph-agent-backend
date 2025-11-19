/**
 * User Context Utility
 *
 * Fetches comprehensive user information from PostgreSQL database by userId
 * including profile, listings, collections, CMAs, and showings.
 */

import { Pool } from 'pg';
import { UserContext } from '../types/state.js';

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Fetch comprehensive user information from database by userId
 *
 * This fetches:
 * - User profile (from users table)
 * - User listings (from user_listings table)
 * - User collections (from user_collections table)
 * - CMA reports (from cma_reports table)
 * - Property showings (from property_showings table)
 *
 * @param userId - User ID to fetch information for
 * @returns UserContext object with complete user information
 *
 * @example
 * ```typescript
 * const userContext = await getUserContextById('user_123');
 * console.log(userContext.fullName); // "John Doe"
 * console.log(userContext.linkedListingsCount); // 5
 * console.log(userContext.collections); // [{id: '...', title: 'Favorites', ...}]
 * ```
 */
export async function getUserContextById(userId: string | undefined): Promise<UserContext> {
  // If no userId provided, return guest context
  if (!userId) {
    console.log('[UserContext] No userId provided - returning guest context');
    return {
      isAuthenticated: false,
    };
  }

  try {
    console.log(`[UserContext] Fetching comprehensive context for userId: ${userId}`);

    // Fetch user profile
    const userResult = await pool.query(
      `SELECT
        id, email, full_name, first_name, last_name, phone,
        license_number, license_state, member_key, member_mls_id,
        office_key, office_name, profile_picture, bio, website,
        status, linked_listings_count
       FROM users
       WHERE id = $1 AND status = 'active'
       LIMIT 1`,
      [userId]
    );

    // If user not found or inactive, return guest context
    if (userResult.rows.length === 0) {
      console.warn(`[UserContext] User not found or inactive: ${userId}`);
      return {
        isAuthenticated: false,
      };
    }

    const user = userResult.rows[0];
    console.log(`[UserContext] ✓ User profile fetched: ${user.full_name}`);

    // Fetch user listings (limit to 50 most recent)
    const listingsResult = await pool.query(
      `SELECT
        listing_id, linked_at, linked_via, is_active, listing_data
       FROM user_listings
       WHERE user_id = $1 AND is_active = true
       ORDER BY linked_at DESC
       LIMIT 50`,
      [userId]
    );
    console.log(`[UserContext] ✓ Found ${listingsResult.rows.length} active listings`);

    // Fetch user collections (limit to 50 most recent)
    const collectionsResult = await pool.query(
      `SELECT
        id, title, description,
        jsonb_array_length(properties) as properties_count,
        created_at, updated_at
       FROM user_collections
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    console.log(`[UserContext] ✓ Found ${collectionsResult.rows.length} collections`);

    // Fetch CMA reports (limit to 50 most recent)
    const cmasResult = await pool.query(
      `SELECT
        id, job_id, listing_id, status, progress_percentage,
        property_address, created_at, completed_at
       FROM cma_reports
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    console.log(`[UserContext] ✓ Found ${cmasResult.rows.length} CMA reports`);

    // Fetch property showings (limit to 100 most recent)
    // Include both as requester and as owner
    const showingsResult = await pool.query(
      `SELECT
        id, property_id, property_address, scheduled_at, status,
        requester_name, created_at
       FROM property_showings
       WHERE requester_user_id = $1 OR owner_user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId]
    );
    console.log(`[UserContext] ✓ Found ${showingsResult.rows.length} showings`);

    // Build comprehensive user context
    const userContext: UserContext = {
      isAuthenticated: true,

      // Basic profile
      userId: user.id,
      fullName: user.full_name,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      phone: user.phone,
      licenseNumber: user.license_number,
      licenseState: user.license_state,
      memberKey: user.member_key,
      memberMlsId: user.member_mls_id,
      officeKey: user.office_key,
      officeName: user.office_name,
      profilePicture: user.profile_picture,
      bio: user.bio,
      website: user.website,
      status: user.status,

      // Counts
      linkedListingsCount: user.linked_listings_count || 0,
      collectionsCount: collectionsResult.rows.length,
      cmasCount: cmasResult.rows.length,
      showingsCount: showingsResult.rows.length,

      // Detailed data
      listings: listingsResult.rows.map(row => ({
        listingId: row.listing_id,
        linkedAt: row.linked_at,
        linkedVia: row.linked_via,
        isActive: row.is_active,
        listingData: row.listing_data,
      })),

      collections: collectionsResult.rows.map(row => ({
        id: row.id,
        title: row.title,
        description: row.description,
        propertiesCount: parseInt(row.properties_count) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),

      cmas: cmasResult.rows.map(row => ({
        id: row.id,
        jobId: row.job_id,
        listingId: row.listing_id,
        status: row.status,
        progressPercentage: row.progress_percentage || 0,
        propertyAddress: row.property_address,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      })),

      showings: showingsResult.rows.map(row => ({
        id: row.id,
        propertyId: row.property_id,
        propertyAddress: row.property_address,
        scheduledAt: row.scheduled_at,
        status: row.status,
        requesterName: row.requester_name,
        createdAt: row.created_at,
      })),
    };

    console.log(`[UserContext] ✓ Complete context built for ${user.full_name}:`);
    console.log(`  - Listings: ${userContext.linkedListingsCount}`);
    console.log(`  - Collections: ${userContext.collectionsCount}`);
    console.log(`  - CMAs: ${userContext.cmasCount}`);
    console.log(`  - Showings: ${userContext.showingsCount}`);

    return userContext;
  } catch (error) {
    console.error('[UserContext] Error fetching user context from database:', error);
    // On database error, return guest context (fail safe)
    return {
      isAuthenticated: false,
    };
  }
}

/**
 * Close database connection pool
 * Call this on application shutdown
 */
export async function closeUserContextPool(): Promise<void> {
  await pool.end();
}
