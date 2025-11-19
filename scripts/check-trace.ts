import { Client } from "langsmith";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function checkTrace(traceId: string) {
  const client = new Client({
    apiKey: process.env.LANGCHAIN_API_KEY,
  });

  console.log(`\n🔍 Fetching trace: ${traceId}\n`);

  try {
    // Get all runs for this specific trace
    const runs = client.listRuns({
      projectName: process.env.LANGCHAIN_PROJECT || "property-search-langgraph-agent",
      traceId: traceId,
    });

    let runCount = 0;
    const runsList: any[] = [];

    for await (const run of runs) {
      runCount++;
      runsList.push(run);

      console.log(`\n--- Run ${runCount} ---`);
      console.log(`ID: ${run.id}`);
      console.log(`Name: ${run.name}`);
      console.log(`Type: ${run.run_type}`);
      console.log(`Start Time: ${run.start_time}`);
      console.log(`End Time: ${run.end_time}`);
      console.log(`Status: ${run.status || 'N/A'}`);
      console.log(`Error: ${run.error || 'None'}`);
      console.log(`Parent Run ID: ${run.parent_run_id || 'None (Root)'}`);

      if (run.inputs) {
        console.log(`\nInputs:`);
        console.log(JSON.stringify(run.inputs, null, 2).substring(0, 500));
      }

      if (run.outputs) {
        console.log(`\nOutputs:`);
        console.log(JSON.stringify(run.outputs, null, 2).substring(0, 500));
      }

      if (run.extra) {
        console.log(`\nExtra Metadata:`);
        console.log(JSON.stringify(run.extra, null, 2).substring(0, 300));
      }
    }

    console.log(`\n\n📊 Summary:`);
    console.log(`Total runs in trace: ${runCount}`);

    // Analyze trace structure
    const rootRuns = runsList.filter(r => !r.parent_run_id);
    const llmRuns = runsList.filter(r => r.run_type === 'llm');
    const toolRuns = runsList.filter(r => r.run_type === 'tool');
    const chainRuns = runsList.filter(r => r.run_type === 'chain');
    const errorRuns = runsList.filter(r => r.error);

    console.log(`Root runs: ${rootRuns.length}`);
    console.log(`LLM runs: ${llmRuns.length}`);
    console.log(`Tool runs: ${toolRuns.length}`);
    console.log(`Chain runs: ${chainRuns.length}`);
    console.log(`Runs with errors: ${errorRuns.length}`);

    if (errorRuns.length > 0) {
      console.log(`\n⚠️  Errors found:`);
      errorRuns.forEach(run => {
        console.log(`  - ${run.name}: ${run.error}`);
      });
    }

    // Calculate total latency
    if (rootRuns.length > 0) {
      const rootRun = rootRuns[0];
      if (rootRun.start_time && rootRun.end_time) {
        const latency = new Date(rootRun.end_time).getTime() - new Date(rootRun.start_time).getTime();
        console.log(`\n⏱️  Total trace latency: ${latency}ms (${(latency / 1000).toFixed(2)}s)`);
      }
    }

  } catch (error) {
    console.error(`\n❌ Error fetching trace:`, error);
    if (error instanceof Error) {
      console.error(`Error message: ${error.message}`);
      console.error(`Error stack: ${error.stack}`);
    }
  }
}

// Get trace ID from command line or use default
const traceId = process.argv[2] || "6cb63716-0050-40b6-9da2-1ef9706490e9";
checkTrace(traceId);
