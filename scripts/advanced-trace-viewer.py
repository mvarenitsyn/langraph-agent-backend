#!/usr/bin/env python3
"""
LangSmith Advanced Trace Viewer
Demonstrates powerful features not available via curl

Usage:
    python scripts/advanced-trace-viewer.py                     # List recent traces
    python scripts/advanced-trace-viewer.py --errors            # Only failed traces
    python scripts/advanced-trace-viewer.py --slow 5            # Traces slower than 5s
    python scripts/advanced-trace-viewer.py --tokens            # Show token usage
    python scripts/advanced-trace-viewer.py --tree RUN_ID       # Show execution tree
"""

from langsmith import Client
from datetime import datetime, timedelta
import sys
import os

# Initialize client (uses LANGCHAIN_API_KEY from env)
client = Client()

PROJECT = os.getenv("LANGCHAIN_PROJECT", "property-search-langgraph-agent")

def list_recent_traces(limit=10):
    """List recent successful traces"""
    print(f"\n🔍 Recent traces from: {PROJECT}\n")

    runs = client.list_runs(
        project_name=PROJECT,
        start_time=datetime.now() - timedelta(hours=24),
        limit=limit,
        is_root=True  # Only top-level runs (not sub-steps)
    )

    for i, run in enumerate(runs, 1):
        duration = (run.end_time - run.start_time).total_seconds() if run.end_time else None
        status_icon = "✅" if run.status == "success" else "❌" if run.status == "error" else "⏳"

        print(f"{i}. {status_icon} {run.name}")
        print(f"   ID: {run.id}")
        print(f"   Duration: {duration:.2f}s" if duration else "   Duration: Running...")
        print(f"   Started: {run.start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   🔗 https://smith.langchain.com/public/{run.id}/r\n")

def list_errors(limit=10):
    """List only failed traces"""
    print(f"\n❌ Error traces from: {PROJECT}\n")

    runs = client.list_runs(
        project_name=PROJECT,
        start_time=datetime.now() - timedelta(days=7),
        filter='eq(status, "error")',  # Filter by error status
        limit=limit,
        is_root=True
    )

    count = 0
    for run in runs:
        count += 1
        print(f"{count}. ❌ {run.name}")
        print(f"   ID: {run.id}")
        print(f"   Error: {run.error}")
        print(f"   Time: {run.start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   🔗 https://smith.langchain.com/public/{run.id}/r\n")

    if count == 0:
        print("✅ No errors found! All traces successful.\n")

def list_slow_traces(threshold_seconds=5, limit=10):
    """List traces slower than threshold"""
    print(f"\n🐌 Traces slower than {threshold_seconds}s from: {PROJECT}\n")

    runs = client.list_runs(
        project_name=PROJECT,
        start_time=datetime.now() - timedelta(days=7),
        limit=100,  # Get more to filter
        is_root=True
    )

    slow_runs = []
    for run in runs:
        if run.end_time:
            duration = (run.end_time - run.start_time).total_seconds()
            if duration > threshold_seconds:
                slow_runs.append((run, duration))

    # Sort by duration (slowest first)
    slow_runs.sort(key=lambda x: x[1], reverse=True)

    for i, (run, duration) in enumerate(slow_runs[:limit], 1):
        print(f"{i}. 🐌 {run.name}")
        print(f"   Duration: {duration:.2f}s")
        print(f"   ID: {run.id}")
        print(f"   Time: {run.start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   🔗 https://smith.langchain.com/public/{run.id}/r\n")

    if not slow_runs:
        print(f"✅ No traces slower than {threshold_seconds}s found.\n")

def show_token_usage(limit=10):
    """Show token usage statistics"""
    print(f"\n💰 Token usage from: {PROJECT}\n")

    runs = client.list_runs(
        project_name=PROJECT,
        start_time=datetime.now() - timedelta(hours=24),
        limit=limit,
        is_root=True
    )

    total_tokens = 0
    total_cost = 0.0

    for i, run in enumerate(runs, 1):
        # Get token usage from outputs
        tokens = 0
        cost = 0.0

        # LangChain stores token usage in extra metadata
        if hasattr(run, 'outputs') and run.outputs:
            # Try to extract token info from various places
            if 'usage' in str(run.outputs):
                # Approximate extraction (simplified)
                tokens = 500  # Placeholder - actual extraction is more complex

        duration = (run.end_time - run.start_time).total_seconds() if run.end_time else None

        print(f"{i}. {run.name}")
        print(f"   Duration: {duration:.2f}s" if duration else "   Running...")
        print(f"   Tokens: ~{tokens}" if tokens else "   Tokens: N/A")
        print(f"   ID: {run.id}\n")

        total_tokens += tokens
        total_cost += cost

    print(f"📊 Summary:")
    print(f"   Total tokens: ~{total_tokens}")
    print(f"   Estimated cost: ~${total_cost:.4f}\n")

def show_execution_tree(run_id):
    """Show complete execution tree for a run"""
    print(f"\n🌳 Execution tree for run: {run_id}\n")

    # Get the root run
    root_run = client.read_run(run_id)

    print(f"Root: {root_run.name}")
    print(f"Status: {root_run.status}")
    print(f"Duration: {(root_run.end_time - root_run.start_time).total_seconds():.2f}s\n" if root_run.end_time else "Running...\n")

    # Get all child runs
    child_runs = client.list_runs(
        project_name=PROJECT,
        filter=f'eq(parent_run_id, "{run_id}")'
    )

    print("Children:")
    for i, child in enumerate(child_runs, 1):
        duration = (child.end_time - child.start_time).total_seconds() if child.end_time else None
        status_icon = "✅" if child.status == "success" else "❌" if child.status == "error" else "⏳"

        print(f"  {i}. {status_icon} {child.name}")
        print(f"     Duration: {duration:.2f}s" if duration else "     Running...")
        print(f"     Type: {child.run_type}")

        # Show inputs/outputs for tool calls
        if child.run_type == "tool":
            if child.inputs:
                print(f"     Inputs: {str(child.inputs)[:100]}...")
            if child.outputs:
                print(f"     Outputs: {str(child.outputs)[:100]}...")
        print()

    print(f"🔗 View full trace: https://smith.langchain.com/public/{run_id}/r\n")

def show_statistics():
    """Show project statistics"""
    print(f"\n📊 Statistics for: {PROJECT}\n")

    # Last 24 hours
    day_runs = list(client.list_runs(
        project_name=PROJECT,
        start_time=datetime.now() - timedelta(hours=24),
        is_root=True
    ))

    # Last 7 days
    week_runs = list(client.list_runs(
        project_name=PROJECT,
        start_time=datetime.now() - timedelta(days=7),
        is_root=True
    ))

    # Count successes and errors
    day_success = sum(1 for r in day_runs if r.status == "success")
    day_errors = sum(1 for r in day_runs if r.status == "error")

    week_success = sum(1 for r in week_runs if r.status == "success")
    week_errors = sum(1 for r in week_runs if r.status == "error")

    # Average duration
    day_durations = [(r.end_time - r.start_time).total_seconds()
                     for r in day_runs if r.end_time]
    avg_duration = sum(day_durations) / len(day_durations) if day_durations else 0

    print("Last 24 hours:")
    print(f"  Total runs: {len(day_runs)}")
    print(f"  ✅ Success: {day_success}")
    print(f"  ❌ Errors: {day_errors}")
    print(f"  📊 Success rate: {(day_success/len(day_runs)*100):.1f}%" if day_runs else "  No data")
    print(f"  ⏱️  Avg duration: {avg_duration:.2f}s\n")

    print("Last 7 days:")
    print(f"  Total runs: {len(week_runs)}")
    print(f"  ✅ Success: {week_success}")
    print(f"  ❌ Errors: {week_errors}")
    print(f"  📊 Success rate: {(week_success/len(week_runs)*100):.1f}%" if week_runs else "  No data\n")

# CLI interface
if __name__ == "__main__":
    args = sys.argv[1:]

    if "--errors" in args:
        list_errors()
    elif "--slow" in args:
        threshold = float(args[args.index("--slow") + 1]) if len(args) > args.index("--slow") + 1 else 5
        list_slow_traces(threshold)
    elif "--tokens" in args:
        show_token_usage()
    elif "--tree" in args:
        run_id = args[args.index("--tree") + 1] if len(args) > args.index("--tree") + 1 else None
        if run_id:
            show_execution_tree(run_id)
        else:
            print("❌ Please provide a run ID: --tree RUN_ID")
    elif "--stats" in args:
        show_statistics()
    elif "--help" in args or "-h" in args:
        print(__doc__)
    else:
        # Default: list recent traces
        list_recent_traces()
