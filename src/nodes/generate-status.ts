/**
 * Generate Status Node
 *
 * Generates user-friendly status messages for tool executions in parallel.
 * Uses GPT-3.5-turbo for fast, cheap status generation while tools execute.
 *
 * This node runs in parallel with the tools node via Send() API.
 */

import { AgentState } from "../types/state.js";
import { gpt35TurboClient, createStatusPrompt } from "../utils/openai.js";
import { AgentPublisher } from "../pubsub/publisher.js";
import { PubSub } from "@google-cloud/pubsub";
import { AIMessage } from "@langchain/core/messages";

// Initialize Pub/Sub client
const pubsub = new PubSub();
const publisher = new AgentPublisher(pubsub);

/**
 * Generate status node
 *
 * Extracts tool calls from last AIMessage, generates user-friendly status
 * messages via GPT-3.5-turbo, and publishes them to agent.text.stream topic.
 *
 * Runs in parallel with tools node - does NOT block tool execution.
 */
export async function generateStatusNode(
  state: typeof AgentState.State
): Promise<Partial<typeof AgentState.State>> {
  try {
    console.log("[GenerateStatus] Starting parallel status generation...");

    // Use pendingToolCalls from state (explicitly passed via Send)
    // This is needed because Send() passes state by VALUE, so we receive state snapshot
    // BEFORE router's return value is merged
    const toolCalls = state.pendingToolCalls || [];

    if (toolCalls.length === 0) {
      console.log("[GenerateStatus] No pending tool calls");
      return {};
    }

    console.log(`[GenerateStatus] Generating status for ${toolCalls.length} tool call(s) from pendingToolCalls`);

    // Extract session metadata for Pub/Sub
    const sessionId = state.metadata?.sessionId || "unknown";
    const userId = state.metadata?.userId;
    const correlationId = state.metadata?.correlationId || `status-${Date.now()}`;

    // Generate status for each tool call in parallel
    const statusPromises = toolCalls.map(async (toolCall) => {
      try {
        const { id, name, args } = toolCall;
        console.log(`[GenerateStatus] Generating status for ${name} (${id})`);

        // Get static status message directly (no LLM call needed)
        const fullStatus = createStatusPrompt(name, args);

        console.log(`[GenerateStatus] ✓ Using static status message for ${name} (${fullStatus.length} chars)`);

        // Publish completion marker to signal frontend to create a new message for the main response
        try {
          await publisher.publishTextChunk({
            correlationId,
            sessionId,
            userId,
            chunk: "",
            nodeId: `generate_status_${name}`,
            isComplete: true,
          });
          console.log(`[GenerateStatus] ✓ Published completion marker`);
        } catch (publishError) {
          console.error(`[GenerateStatus] ✗ Failed to publish completion marker:`, publishError);
        }

        console.log(`[GenerateStatus] ✓ Generated status for ${name}: "${fullStatus.trim()}"`);
        return {
          toolCallId: id,
          message: fullStatus.trim(),
        };
      } catch (error) {
        // Non-blocking: Don't fail if status generation fails for one tool
        console.error(`[GenerateStatus] Failed to generate status for tool ${toolCall.name}:`, error);
        return {
          toolCallId: toolCall.id,
          message: `Executing ${toolCall.name}...`, // Fallback generic status
        };
      }
    });

    // Wait for all statuses to generate (should be fast, ~1-2 seconds total)
    const statuses = await Promise.all(statusPromises);

    // Build statusMessages map for state tracking
    const statusMessages = statuses.reduce((acc, status) => {
      acc[status.toolCallId] = status.message;
      return acc;
    }, {} as Record<string, string>);

    console.log(`[GenerateStatus] ✓ Completed status generation for all tools`);

    // Return state update (only updates statusMessages, doesn't modify messages array)
    return {
      statusMessages,
    };
  } catch (error) {
    // Non-fatal error: log but don't block graph execution
    console.error("[GenerateStatus] Status generation failed (non-fatal):", error);
    return {};
  }
}
