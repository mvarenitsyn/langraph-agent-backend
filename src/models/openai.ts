import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config/index.js";
import { ReflectionOutputSchema } from "../types/reflection.js";

/**
 * OpenAI Models Module
 *
 * Centralized management of OpenAI model instances with credentials
 */

/**
 * Create a ChatOpenAI instance with configured credentials
 */
export function createChatModel(options?: {
  model?: string;
  temperature?: number;
  streaming?: boolean;
  maxTokens?: number;
  timeout?: number;
}) {
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: options?.model || config.openai.model,
    temperature: options?.temperature ?? config.openai.temperature,
    streaming: options?.streaming ?? true,
    maxTokens: options?.maxTokens,
    timeout: options?.timeout ?? config.timeouts.model,
  });
}

/**
 * Create a ChatOpenAI instance optimized for tool calling
 */
export function createToolCallingModel(maxTokens?: number) {
  // GPT-5 only supports temperature=1
  const temperature = config.openai.model.includes('gpt-5') ? 1 : 0.1;
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    temperature,
    streaming: false, // Disabled to prevent verbose acknowledgement messages in property_operations
    maxTokens: maxTokens ?? config.tokenLimits.router,
    timeout: config.timeouts.model,
  });
}

/**
 * Create a ChatOpenAI instance optimized for reflection/analysis
 * Returns structured output matching ReflectionOutputSchema
 */
export function createReflectionModel(maxTokens?: number) {
  // GPT-5 only supports temperature=1
  const temperature = config.openai.model.includes('gpt-5') ? 1 : 0.3;
  const baseModel = new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    temperature,
    streaming: false, // Structured output requires non-streaming
    maxTokens: maxTokens ?? config.tokenLimits.reflect,
    timeout: config.timeouts.model,
  });

  // Return model with structured output using Zod schema
  return baseModel.withStructuredOutput(ReflectionOutputSchema, {
    name: 'reflection_output',
  });
}

/**
 * Create a ChatOpenAI instance optimized for final response generation
 */
export function createResponseModel(maxTokens?: number) {
  // GPT-5 only supports temperature=1
  const temperature = config.openai.model.includes('gpt-5') ? 1 : config.openai.temperature;
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    temperature,
    streaming: true,
    maxTokens: maxTokens ?? config.tokenLimits.generateResponse,
    timeout: config.timeouts.model,
  });
}

/**
 * Create a ChatOpenAI instance optimized for routing decisions
 * Streaming is disabled because routing directives (ROUTE: PROPERTY_SEARCH, etc.)
 * are internal signals and should not be streamed to users
 */
export function createRouterModel(maxTokens?: number) {
  // GPT-5 only supports temperature=1
  const temperature = config.openai.model.includes('gpt-5') ? 1 : 0.1;
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    temperature,
    streaming: false, // Routing decisions are internal - don't stream to users
    maxTokens: maxTokens ?? config.tokenLimits.router,
    timeout: config.timeouts.model,
  });
}

/**
 * Model registry for easy access to different model configurations
 */
export const models = {
  chat: createChatModel,
  toolCalling: createToolCallingModel,
  reflection: createReflectionModel,
  response: createResponseModel,
  router: createRouterModel,
};
