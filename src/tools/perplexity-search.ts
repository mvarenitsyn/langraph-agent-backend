import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../config/index.js";

/**
 * Perplexity Search Tool (Real Implementation)
 *
 * Uses the Perplexity API to perform web searches and get AI-powered answers
 * with citations from fresh web sources.
 */

interface PerplexityResponse {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    finish_reason: string;
    message: {
      role: string;
      content: string;
    };
    delta?: {
      role?: string;
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  citations?: string[];
  search_results?: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

/**
 * Make a request to Perplexity API
 */
async function callPerplexityAPI(
  query: string,
  options?: {
    maxResults?: number;
    searchDomainFilter?: string[];
  },
): Promise<string> {
  const apiKey = config.perplexity.apiKey;

  if (!apiKey) {
    return JSON.stringify({
      success: false,
      error:
        "Perplexity API key not configured. Set PERPLEXITY_API_KEY in .env file.",
    });
  }

  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.perplexity.model,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful research assistant. Provide accurate, well-sourced information with citations.",
          },
          {
            role: "user",
            content: query,
          },
        ],
        max_tokens: 1024,
        temperature: 0.2,
        top_p: 0.9,
        search_domain_filter: options?.searchDomainFilter,
        return_citations: true,
        return_images: false,
        search_recency_filter: "month", // Last month's results
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Perplexity API error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as PerplexityResponse;

    return JSON.stringify({
      success: true,
      answer: data.choices[0]?.message?.content || "No answer received",
      citations: data.citations || [],
      usage: data.usage,
    });
  } catch (error) {
    console.error("[PerplexitySearchTool] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
}

/**
 * Perplexity Search Tool
 */
export const perplexitySearchTool = new DynamicStructuredTool({
  name: "perplexity_search",
  description:
    "Search the web using Perplexity AI to get recent, accurate information with citations. Use this for real-time information, current events, market data, or any questions requiring up-to-date web sources.",
  schema: z.object({
    query: z
      .string()
      .describe("The search query or question to ask Perplexity"),
    searchDomainFilter: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of domains to limit search to (e.g., ['nytimes.com', 'reuters.com'])",
      ),
  }),
  func: async ({ query, searchDomainFilter }) => {
    console.log(`[PerplexitySearchTool] Searching: "${query}"`);
    return await callPerplexityAPI(query, { searchDomainFilter });
  },
});

/**
 * Perplexity Real Estate Research Tool
 * Specialized variant for real estate market research
 */
export const perplexityRealEstateResearchTool = new DynamicStructuredTool({
  name: "perplexity_real_estate_research",
  description:
    "Research real estate market trends, neighborhood information, housing prices, or property-related topics using Perplexity AI. Get current market data with citations.",
  schema: z.object({
    topic: z
      .string()
      .describe(
        "The real estate topic to research (e.g., 'San Francisco housing market trends 2025', 'best neighborhoods in Oakland')",
      ),
    location: z
      .string()
      .optional()
      .describe("Specific location to focus the research on"),
  }),
  func: async ({ topic, location }) => {
    const query = location
      ? `${topic} in ${location} - provide current market data and trends`
      : `${topic} - provide current market data and trends`;

    console.log(`[PerplexityRealEstateResearchTool] Researching: "${query}"`);

    // Focus on real estate and news domains
    const searchDomainFilter = [
      "zillow.com",
      "realtor.com",
      "redfin.com",
      "forbes.com",
      "wsj.com",
      "bloomberg.com",
    ];

    return await callPerplexityAPI(query, { searchDomainFilter });
  },
});
