/**
 * User Context Utility
 *
 * Fetches user information from PostgreSQL database by userId
 * and formats it for agent context injection.
 */

import { Pool } from 'pg';

// Database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * User context interface matching the schema expected by the agent
 */
export interface UserContext {
  isAuthenticated: boolean;
  fullName?: string;
  email?: string;
  licenseNumber?: string;
  userId?: string;
}

/**
 * Fetch user information from database by userId
 *
 * @param userId - User ID to fetch information for
 * @returns UserContext object with user information
 *
 * @example
 * ```typescript
 * const userContext = await getUserContextById('user_123');
 * console.log(userContext.fullName); // "John Doe"
 * ```
 */
export async function getUserContextById(userId: string | undefined): Promise<UserContext> {
  // If no userId provided, return unauthenticated context
  if (!userId) {
    return {
      isAuthenticated: false,
    };
  }

  try {
    // Query user information from database
    const result = await pool.query(
      `SELECT id, email, full_name, license_number
       FROM users
       WHERE id = $1 AND status = 'active'
       LIMIT 1`,
      [userId]
    );

    // If user not found or inactive, return unauthenticated
    if (result.rows.length === 0) {
      console.warn(`[UserContext] User not found or inactive: ${userId}`);
      return {
        isAuthenticated: false,
      };
    }

    const user = result.rows[0];

    // Return authenticated user context
    return {
      isAuthenticated: true,
      userId: user.id,
      fullName: user.full_name,
      email: user.email,
      licenseNumber: user.license_number,
    };
  } catch (error) {
    console.error('[UserContext] Error fetching user from database:', error);
    // On database error, return unauthenticated context (fail safe)
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
