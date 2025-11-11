import { Client } from 'pg';
import { config } from '../config/index.js';

/**
 * Setup PostgreSQL Database for Checkpointing
 *
 * Creates the necessary tables for LangGraph checkpointing.
 * Run this script with: npm run setup-db
 */

async function setupDatabase() {
  console.log('[DB Setup] Connecting to PostgreSQL...');
  console.log(`[DB Setup] Database URL: ${config.database.url.replace(/:[^:@]+@/, ':****@')}`);

  const client = new Client({
    connectionString: config.database.url,
  });

  try {
    await client.connect();
    console.log('[DB Setup] ✓ Connected to PostgreSQL');

    // Create checkpoints table
    console.log('[DB Setup] Creating checkpoints table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint JSONB NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (thread_id, checkpoint_id)
      );
    `);
    console.log('[DB Setup] ✓ Checkpoints table created');

    // Create index for faster lookups
    console.log('[DB Setup] Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_id
      ON checkpoints(thread_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at
      ON checkpoints(created_at DESC);
    `);
    console.log('[DB Setup] ✓ Indexes created');

    // Create writes table for checkpoint writes
    console.log('[DB Setup] Creating checkpoint writes table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS checkpoint_writes (
        thread_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (thread_id, checkpoint_id, task_id, idx)
      );
    `);
    console.log('[DB Setup] ✓ Checkpoint writes table created');

    // Verify tables exist
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('checkpoints', 'checkpoint_writes');
    `);

    console.log('[DB Setup] ✓ Database setup complete!');
    console.log('[DB Setup] Tables created:', result.rows.map(r => r.table_name).join(', '));

  } catch (error) {
    console.error('[DB Setup] ✗ Error setting up database:', error);
    throw error;
  } finally {
    await client.end();
    console.log('[DB Setup] Database connection closed');
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase()
    .then(() => {
      console.log('\n✓ Database setup successful!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Database setup failed:', error);
      process.exit(1);
    });
}

export { setupDatabase };
