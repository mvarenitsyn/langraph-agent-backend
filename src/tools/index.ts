/**
 * Tools Index
 *
 * Central export point for all tools
 */

import { globalToolsRegistry } from "./registry.js";
import { propertySearchTool, propertyDetailsTool } from "./property-search.js";
import { perplexitySearchTool, perplexityRealEstateResearchTool } from "./perplexity-search.js";

/**
 * Initialize and register all tools
 */
export function initializeTools() {
  console.log("[Tools] Initializing tools registry...");

  // Register property search tools
  globalToolsRegistry.register(propertySearchTool);
  globalToolsRegistry.register(propertyDetailsTool);

  // Register Perplexity search tools
  globalToolsRegistry.register(perplexitySearchTool);
  globalToolsRegistry.register(perplexityRealEstateResearchTool);

  const stats = globalToolsRegistry.getStats();
  console.log(`[Tools] ✓ Registered ${stats.totalTools} tools: ${stats.toolNames.join(', ')}`);

  return globalToolsRegistry;
}

// Export registry and individual tools
export { globalToolsRegistry };
export { propertySearchTool, propertyDetailsTool } from "./property-search.js";
export { perplexitySearchTool, perplexityRealEstateResearchTool } from "./perplexity-search.js";
