#!/usr/bin/env node

/**
 * LangSmith Trace Viewer CLI
 *
 * Usage:
 *   node scripts/list-traces.js              # List last 10 traces
 *   node scripts/list-traces.js --limit 20   # List last 20 traces
 *   node scripts/list-traces.js --hours 2    # Last 2 hours only
 */

const https = require('https');

// API key must be set via environment variable
if (!process.env.LANGCHAIN_API_KEY) {
  console.error('❌ Error: LANGCHAIN_API_KEY environment variable is required');
  console.error('   Set it in your .env file or export it:');
  console.error('   export LANGCHAIN_API_KEY=your_key_here\n');
  process.exit(1);
}

const API_KEY = process.env.LANGCHAIN_API_KEY;
const PROJECT = process.env.LANGCHAIN_PROJECT || 'property-search-langgraph-agent';

// Parse CLI arguments
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 10;
const hours = args.includes('--hours') ? parseInt(args[args.indexOf('--hours') + 1]) : 24;

// Calculate start time
const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

console.log(`\n🔍 Fetching last ${limit} traces from project: ${PROJECT}`);
console.log(`📅 Time range: Last ${hours} hour(s)\n`);

// Query runs
const postData = JSON.stringify({
  project: [PROJECT],
  limit: limit,
  start_time: startTime
});

const options = {
  hostname: 'api.smith.langchain.com',
  port: 443,
  path: '/runs/query',
  method: 'POST',
  headers: {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json',
    'Content-Length': postData.length
  }
};

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`❌ Error: HTTP ${res.statusCode}`);
      console.error(data);
      return;
    }

    const response = JSON.parse(data);
    const runs = response.runs || [];

    if (runs.length === 0) {
      console.log('📭 No traces found in the specified time range.\n');
      return;
    }

    console.log(`✅ Found ${runs.length} trace(s):\n`);

    runs.forEach((run, index) => {
      const startTime = new Date(run.start_time);
      const endTime = run.end_time ? new Date(run.end_time) : null;
      const duration = endTime ? ((endTime - startTime) / 1000).toFixed(2) + 's' : 'Running...';

      const statusIcon = run.status === 'success' ? '✅' :
                        run.status === 'error' ? '❌' :
                        run.status === 'pending' ? '⏳' : '⚪';

      console.log(`${index + 1}. ${statusIcon} ${run.name || 'Unnamed'}`);
      console.log(`   ID: ${run.id}`);
      console.log(`   Status: ${run.status}`);
      console.log(`   Duration: ${duration}`);
      console.log(`   Started: ${startTime.toLocaleString()}`);

      if (run.inputs) {
        const inputPreview = JSON.stringify(run.inputs).substring(0, 100);
        console.log(`   Input: ${inputPreview}${JSON.stringify(run.inputs).length > 100 ? '...' : ''}`);
      }

      if (run.error) {
        console.log(`   ❌ Error: ${run.error}`);
      }

      console.log(`   🔗 View: https://smith.langchain.com/public/${run.id}/r\n`);
    });

    console.log(`\n💡 Tip: Add --limit 20 for more results or --hours 2 for shorter time range\n`);
  });
});

req.on('error', (error) => {
  console.error('❌ Request failed:', error.message);
});

req.write(postData);
req.end();
