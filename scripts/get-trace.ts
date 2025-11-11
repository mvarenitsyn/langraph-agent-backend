#!/usr/bin/env tsx
/**
 * Script to fetch and display LangGraph Studio trace data
 *
 * Usage:
 *   tsx scripts/get-trace.ts <thread-id> [run-id]
 *
 * Example:
 *   tsx scripts/get-trace.ts 53452024-1ce7-4322-b0f8-ba926268405f
 *   tsx scripts/get-trace.ts 53452024-1ce7-4322-b0f8-ba926268405f 96b264fc-f2d1-4970-8781-42b482a1dfa1
 */

const STUDIO_BASE_URL = 'http://localhost:8123';

interface Run {
  run_id: string;
  thread_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ThreadHistory {
  values: any[];
  next: string[];
  metadata: any;
}

async function getThreadHistory(threadId: string): Promise<ThreadHistory> {
  const response = await fetch(`${STUDIO_BASE_URL}/threads/${threadId}/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch thread history: ${response.statusText}`);
  }

  return response.json();
}

async function getThreadRuns(threadId: string): Promise<Run[]> {
  const response = await fetch(
    `${STUDIO_BASE_URL}/threads/${threadId}/runs?limit=1000&offset=0`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch thread runs: ${response.statusText}`);
  }

  return response.json();
}

async function getRunStream(threadId: string, runId: string): Promise<any[]> {
  const response = await fetch(
    `${STUDIO_BASE_URL}/threads/${threadId}/runs/${runId}/stream?cancel_on_disconnect=0`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch run stream: ${response.statusText}`);
  }

  const text = await response.text();

  // Parse SSE stream
  const events: any[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        events.push(data);
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }

  return events;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: tsx scripts/get-trace.ts <thread-id> [run-id]');
    process.exit(1);
  }

  const threadId = args[0];
  const runId = args[1];

  try {
    console.log(`\n📊 Fetching trace for thread: ${threadId}\n`);

    // Get thread history
    console.log('=== Thread History ===');
    const history = await getThreadHistory(threadId);
    console.log(JSON.stringify(history, null, 2));

    // Get all runs for this thread
    console.log('\n=== Thread Runs ===');
    const runs = await getThreadRuns(threadId);
    console.log(`Found ${runs.length} run(s)`);
    runs.forEach((run, i) => {
      console.log(`\n  Run ${i + 1}:`);
      console.log(`    ID: ${run.run_id}`);
      console.log(`    Status: ${run.status}`);
      console.log(`    Created: ${run.created_at}`);
    });

    // Get specific run stream if runId provided, otherwise get latest
    const targetRunId = runId || (runs.length > 0 ? runs[0].run_id : null);

    if (targetRunId) {
      console.log(`\n=== Run Stream: ${targetRunId} ===`);
      const events = await getRunStream(threadId, targetRunId);
      console.log(`\nReceived ${events.length} events:\n`);

      events.forEach((event, i) => {
        console.log(`\nEvent ${i + 1}:`);
        console.log(JSON.stringify(event, null, 2));
      });
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
