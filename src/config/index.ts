import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export const config = {
  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    reasoning: { "effort": "low" },
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
  },

  // Perplexity Configuration
  perplexity: {
    apiKey: process.env.PERPLEXITY_API_KEY || '',
    model: 'sonar',
  },

  // Database Configuration
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/langraph_checkpoints',
  },

  // Server Configuration
  server: {
    port: parseInt(process.env.PORT || '3003', 10),
    env: process.env.NODE_ENV || 'development',
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  // Pub/Sub Configuration
  pubsub: {
    projectId: process.env.GCP_PROJECT_ID || 'gen-lang-client-0355624828',
    uiRenderTopic: process.env.UI_RENDER_TOPIC || 'ui.render',
  },

  // Agent Configuration
  agent: {
    maxRetries: 3,
    streamMode: 'values' as const,
    recursionLimit: parseInt(process.env.RECURSION_LIMIT || '25', 10),
  },

  // Token Limits per Node
  tokenLimits: {
    router: parseInt(process.env.TOKEN_LIMIT_ROUTER || '8000', 10),
    reflect: parseInt(process.env.TOKEN_LIMIT_REFLECT || '4000', 10),
    generateResponse: parseInt(process.env.TOKEN_LIMIT_GENERATE_RESPONSE || '16000', 10),
    // Tool-specific limits
    propertySearch: parseInt(process.env.TOKEN_LIMIT_PROPERTY_SEARCH || '4000', 10),
    propertyDetails: parseInt(process.env.TOKEN_LIMIT_PROPERTY_DETAILS || '4000', 10),
    perplexitySearch: parseInt(process.env.TOKEN_LIMIT_PERPLEXITY_SEARCH || '4000', 10),
    perplexityRealEstateResearch: parseInt(process.env.TOKEN_LIMIT_PERPLEXITY_RESEARCH || '8000', 10),
  },

  // Timeout Configuration (milliseconds)
  timeouts: {
    model: parseInt(process.env.MODEL_TIMEOUT || '60000', 10),
    tool: parseInt(process.env.TOOL_TIMEOUT || '30000', 10),
  },
};

/**
 * Validate that all required environment variables are set
 */
export function validateConfig() {
  const required = [
    { key: 'OPENAI_API_KEY', value: config.openai.apiKey },
    { key: 'DATABASE_URL', value: config.database.url },
  ];

  const missing = required.filter(({ value }) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.map(m => m.key).join(', ')}\n` +
      'Please copy .env.example to .env and fill in the required values.'
    );
  }
}
