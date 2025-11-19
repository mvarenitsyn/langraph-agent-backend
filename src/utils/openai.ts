/**
 * Shared OpenAI client for agent services
 */

import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config/index.js";

/**
 * GPT-4 client for main agent reasoning
 * Used by router node
 */
export const gpt4Client = new ChatOpenAI({
  modelName: config.openai.model,
  temperature: 0,
  streaming: true,
  openAIApiKey: config.openai.apiKey,
});

/**
 * GPT-3.5-turbo client for fast status generation
 * Used by generate-status node for quick user feedback
 */
export const gpt35TurboClient = new ChatOpenAI({
  modelName: "gpt-3.5-turbo",
  temperature: 0.8, // Slightly creative for natural language
  maxTokens: 50,    // Keep status messages short
  streaming: true,  // Stream tokens for faster perceived response
  openAIApiKey: config.openai.apiKey,
});

/**
 * Create a status generation prompt for a tool call
 */
export function createStatusPrompt(toolName: string, toolArgs: Record<string, any>): string {
  // Format parameters as readable string
  const paramsStr = Object.entries(toolArgs)
    .map(([key, value]) => {
      // Truncate long values
      const valueStr = typeof value === 'string' && value.length > 100
        ? value.substring(0, 100) + '...'
        : JSON.stringify(value);
      return `${key}: ${valueStr}`;
    })
    .join(', ');

  // Map tool names to clear, concise status messages
  const statusMessages: Record<string, string> = {
    'property_search': 'Searching MLS data...',
    'property_details': 'Getting property details...',
    'property_filter_sort': 'Filtering results...',
    'property_get_results': 'Loading search results...',
    'property_get_details': 'Fetching full property data...',
    'perplexity_search': 'Searching the web...',
    'validate_address': 'Validating address...',
  };

  // Return predefined message or generic fallback
  return statusMessages[toolName] || `Processing ${toolName}...`;
}
