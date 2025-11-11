#!/usr/bin/env tsx
/**
 * LangSmith Advanced Trace Viewer (TypeScript)
 * Full-featured trace viewer using LangSmith TypeScript SDK
 *
 * Usage:
 *   npm run trace                              # List recent traces
 *   npm run trace -- --errors                  # Only failed traces
 *   npm run trace -- --slow 5                  # Traces slower than 5s
 *   npm run trace -- --tree RUN_ID             # Show execution tree
 *   npm run trace -- --stats                   # Show statistics
 *   npm run trace -- --search "property"       # Search by query text
 */

import { Client, Run } from "langsmith";
import * as dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: resolve(__dirname, "../.env") });

// Initialize client (uses LANGCHAIN_API_KEY from env)
const client = new Client({
  apiKey: process.env.LANGCHAIN_API_KEY,
});

const PROJECT = process.env.LANGCHAIN_PROJECT || "property-search-langgraph-agent";

/**
 * List recent successful traces
 */
async function listRecentTraces(limit = 10) {
  console.log(`\n🔍 Recent traces from: ${PROJECT}\n`);

  const runs = await client.listRuns({
    projectName: PROJECT,
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
    limit,
    isRoot: true, // Only top-level runs
  });

  let i = 1;
  for await (const run of runs) {
    const startTime = new Date(run.start_time);
    const endTime = run.end_time ? new Date(run.end_time) : null;
    const duration = endTime
      ? (endTime.getTime() - startTime.getTime()) / 1000
      : null;
    const statusIcon = run.status === "success" ? "✅" : run.status === "error" ? "❌" : "⏳";

    console.log(`${i}. ${statusIcon} ${run.name}`);
    console.log(`   ID: ${run.id}`);
    console.log(duration ? `   Duration: ${duration.toFixed(2)}s` : "   Duration: Running...");
    console.log(`   Started: ${startTime.toISOString().replace("T", " ").substring(0, 19)}`);
    console.log(`   🔗 https://smith.langchain.com/public/${run.id}/r\n`);
    i++;
  }
}

/**
 * List only failed traces
 */
async function listErrors(limit = 10) {
  console.log(`\n❌ Error traces from: ${PROJECT}\n`);

  const runs = await client.listRuns({
    projectName: PROJECT,
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
    filter: 'eq(status, "error")',
    limit,
    isRoot: true,
  });

  let count = 0;
  for await (const run of runs) {
    count++;
    const startTime = new Date(run.start_time);
    console.log(`${count}. ❌ ${run.name}`);
    console.log(`   ID: ${run.id}`);
    console.log(`   Error: ${run.error || "Unknown error"}`);
    console.log(`   Time: ${startTime.toISOString().replace("T", " ").substring(0, 19)}`);
    console.log(`   🔗 https://smith.langchain.com/public/${run.id}/r\n`);
  }

  if (count === 0) {
    console.log("✅ No errors found! All traces successful.\n");
  }
}

/**
 * List traces slower than threshold
 */
async function listSlowTraces(thresholdSeconds = 5, limit = 10) {
  console.log(`\n🐌 Traces slower than ${thresholdSeconds}s from: ${PROJECT}\n`);

  const runs = await client.listRuns({
    projectName: PROJECT,
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    limit: 100, // Get more to filter
    isRoot: true,
  });

  const slowRuns: Array<{ run: Run; duration: number }> = [];
  for await (const run of runs) {
    if (run.end_time) {
      const startTime = new Date(run.start_time);
      const endTime = new Date(run.end_time);
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      if (duration > thresholdSeconds) {
        slowRuns.push({ run, duration });
      }
    }
  }

  // Sort by duration (slowest first)
  slowRuns.sort((a, b) => b.duration - a.duration);

  for (let i = 0; i < Math.min(slowRuns.length, limit); i++) {
    const { run, duration } = slowRuns[i];
    const startTime = new Date(run.start_time);
    console.log(`${i + 1}. 🐌 ${run.name}`);
    console.log(`   Duration: ${duration.toFixed(2)}s`);
    console.log(`   ID: ${run.id}`);
    console.log(`   Time: ${startTime.toISOString().replace("T", " ").substring(0, 19)}`);
    console.log(`   🔗 https://smith.langchain.com/public/${run.id}/r\n`);
  }

  if (slowRuns.length === 0) {
    console.log(`✅ No traces slower than ${thresholdSeconds}s found.\n`);
  }
}

/**
 * Show complete execution tree for a run
 */
async function showExecutionTree(runId: string) {
  console.log(`\n🌳 Execution tree for run: ${runId}\n`);

  try {
    // Get the root run
    const rootRun = await client.readRun(runId);

    console.log(`Root: ${rootRun.name}`);
    console.log(`Status: ${rootRun.status}`);
    if (rootRun.end_time) {
      const startTime = new Date(rootRun.start_time);
      const endTime = new Date(rootRun.end_time);
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      console.log(`Duration: ${duration.toFixed(2)}s\n`);
    } else {
      console.log("Duration: Running...\n");
    }

    // Get all child runs
    const childRuns = await client.listRuns({
      projectName: PROJECT,
      filter: `eq(parent_run_id, "${runId}")`,
    });

    console.log("Children:");
    let i = 1;
    for await (const child of childRuns) {
      const startTime = new Date(child.start_time);
      const endTime = child.end_time ? new Date(child.end_time) : null;
      const duration = endTime
        ? (endTime.getTime() - startTime.getTime()) / 1000
        : null;
      const statusIcon = child.status === "success" ? "✅" : child.status === "error" ? "❌" : "⏳";

      console.log(`  ${i}. ${statusIcon} ${child.name}`);
      console.log(duration ? `     Duration: ${duration.toFixed(2)}s` : "     Running...");
      console.log(`     Type: ${child.run_type}`);

      // Show inputs/outputs for tool calls
      if (child.run_type === "tool") {
        if (child.inputs) {
          const inputStr = JSON.stringify(child.inputs);
          console.log(`     Inputs: ${inputStr.substring(0, 100)}${inputStr.length > 100 ? "..." : ""}`);
        }
        if (child.outputs) {
          const outputStr = JSON.stringify(child.outputs);
          console.log(`     Outputs: ${outputStr.substring(0, 100)}${outputStr.length > 100 ? "..." : ""}`);
        }
      }
      console.log();
      i++;
    }

    console.log(`🔗 View full trace: https://smith.langchain.com/public/${runId}/r\n`);
  } catch (error) {
    console.error(`❌ Error fetching run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Show project statistics
 */
async function showStatistics() {
  console.log(`\n📊 Statistics for: ${PROJECT}\n`);

  // Last 24 hours
  const dayRuns: Run[] = [];
  for await (const run of client.listRuns({
    projectName: PROJECT,
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    isRoot: true,
  })) {
    dayRuns.push(run);
  }

  // Last 7 days
  const weekRuns: Run[] = [];
  for await (const run of client.listRuns({
    projectName: PROJECT,
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    isRoot: true,
  })) {
    weekRuns.push(run);
  }

  // Count successes and errors
  const daySuccess = dayRuns.filter((r) => r.status === "success").length;
  const dayErrors = dayRuns.filter((r) => r.status === "error").length;

  const weekSuccess = weekRuns.filter((r) => r.status === "success").length;
  const weekErrors = weekRuns.filter((r) => r.status === "error").length;

  // Average duration
  const dayDurations = dayRuns
    .filter((r) => r.end_time)
    .map((r) => {
      const startTime = new Date(r.start_time);
      const endTime = new Date(r.end_time!);
      return (endTime.getTime() - startTime.getTime()) / 1000;
    });
  const avgDuration = dayDurations.length > 0
    ? dayDurations.reduce((a, b) => a + b, 0) / dayDurations.length
    : 0;

  console.log("Last 24 hours:");
  console.log(`  Total runs: ${dayRuns.length}`);
  console.log(`  ✅ Success: ${daySuccess}`);
  console.log(`  ❌ Errors: ${dayErrors}`);
  if (dayRuns.length > 0) {
    console.log(`  📊 Success rate: ${((daySuccess / dayRuns.length) * 100).toFixed(1)}%`);
  }
  console.log(`  ⏱️  Avg duration: ${avgDuration.toFixed(2)}s\n`);

  console.log("Last 7 days:");
  console.log(`  Total runs: ${weekRuns.length}`);
  console.log(`  ✅ Success: ${weekSuccess}`);
  console.log(`  ❌ Errors: ${weekErrors}`);
  if (weekRuns.length > 0) {
    console.log(`  📊 Success rate: ${((weekSuccess / weekRuns.length) * 100).toFixed(1)}%\n`);
  } else {
    console.log("  No data\n");
  }
}

/**
 * Search traces by query text
 */
async function searchTraces(searchTerm: string, limit = 10) {
  console.log(`\n🔎 Searching traces for: "${searchTerm}"\n`);

  const runs = await client.listRuns({
    projectName: PROJECT,
    startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    limit: 100,
    isRoot: true,
  });

  const matches: Run[] = [];
  for await (const run of runs) {
    // Search in inputs
    const inputStr = JSON.stringify(run.inputs || {}).toLowerCase();
    if (inputStr.includes(searchTerm.toLowerCase())) {
      matches.push(run);
    }
  }

  console.log(`Found ${matches.length} matching traces:\n`);

  for (let i = 0; i < Math.min(matches.length, limit); i++) {
    const run = matches[i];
    const startTime = new Date(run.start_time);
    const endTime = run.end_time ? new Date(run.end_time) : null;
    const duration = endTime
      ? (endTime.getTime() - startTime.getTime()) / 1000
      : null;
    const statusIcon = run.status === "success" ? "✅" : run.status === "error" ? "❌" : "⏳";

    console.log(`${i + 1}. ${statusIcon} ${run.name}`);
    console.log(`   ID: ${run.id}`);
    console.log(duration ? `   Duration: ${duration.toFixed(2)}s` : "   Duration: Running...");
    console.log(`   Query: ${JSON.stringify(run.inputs).substring(0, 80)}...`);
    console.log(`   🔗 https://smith.langchain.com/public/${run.id}/r\n`);
  }
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
LangSmith Trace Viewer - TypeScript Edition

Usage:
  npm run trace                              # List recent traces
  npm run trace -- --errors                  # Only failed traces
  npm run trace -- --slow <seconds>          # Traces slower than threshold
  npm run trace -- --tree <run_id>           # Show execution tree
  npm run trace -- --stats                   # Show statistics
  npm run trace -- --search <term>           # Search by query text
  npm run trace -- --help                    # Show this help

Examples:
  npm run trace -- --slow 5                  # Show traces slower than 5 seconds
  npm run trace -- --tree abc123def456       # Show execution tree for run ID
  npm run trace -- --search "San Francisco"  # Find traces about SF
  `);
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes("--errors")) {
      await listErrors();
    } else if (args.includes("--slow")) {
      const threshold = parseFloat(args[args.indexOf("--slow") + 1]) || 5;
      await listSlowTraces(threshold);
    } else if (args.includes("--tree")) {
      const runId = args[args.indexOf("--tree") + 1];
      if (runId) {
        await showExecutionTree(runId);
      } else {
        console.log("❌ Please provide a run ID: --tree RUN_ID");
      }
    } else if (args.includes("--stats")) {
      await showStatistics();
    } else if (args.includes("--search")) {
      const searchTerm = args[args.indexOf("--search") + 1];
      if (searchTerm) {
        await searchTraces(searchTerm);
      } else {
        console.log("❌ Please provide a search term: --search TERM");
      }
    } else if (args.includes("--help") || args.includes("-h")) {
      showHelp();
    } else {
      // Default: list recent traces
      await listRecentTraces();
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
