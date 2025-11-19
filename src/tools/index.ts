/**
 * Tools Index
 *
 * Central export point for all tools
 */

import { globalToolsRegistry } from "./registry.js";
import { propertySearchTool, propertyDetailsTool } from "./property-search.js";
import { perplexitySearchTool } from "./perplexity-search.js";
import { propertyFilterSortTool, propertyGetResultsTool, propertyGetDetailsTool } from "./property-operations.js";
import { addressValidatorTool } from "./address-validator.js";

/**
 * Initialize and register all tools
 */
export function initializeTools() {
  console.log("[Tools] Initializing tools registry...");

  // Register property search tools
  globalToolsRegistry.register(propertySearchTool);
  globalToolsRegistry.register(propertyDetailsTool);

  // Register property operations tools (filter, sort, get results, get details)
  globalToolsRegistry.register(propertyFilterSortTool);
  globalToolsRegistry.register(propertyGetResultsTool);
  globalToolsRegistry.register(propertyGetDetailsTool);

  // Register Perplexity search tool
  globalToolsRegistry.register(perplexitySearchTool);

  // Register address validator tool
  globalToolsRegistry.register(addressValidatorTool);

  const stats = globalToolsRegistry.getStats();
  console.log(`[Tools] ✓ Registered ${stats.totalTools} tools: ${stats.toolNames.join(', ')}`);

  return globalToolsRegistry;
}

// Export registry and individual tools
export { globalToolsRegistry };
export { propertySearchTool, propertyDetailsTool } from "./property-search.js";
export { propertyFilterSortTool, propertyGetResultsTool, propertyGetDetailsTool } from "./property-operations.js";
export { perplexitySearchTool } from "./perplexity-search.js";
export { addressValidatorTool } from "./address-validator.js";
