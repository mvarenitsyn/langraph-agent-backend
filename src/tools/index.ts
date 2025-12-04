/**
 * Tools Index
 *
 * Central export point for all tools
 */

import { globalToolsRegistry } from "./registry.js";
// Use ES-based property search tool instead of HTTP-based
import {
  propertySearchESTool,
  propertyDetailsTool,
} from "./property-search-es.js";
import { perplexitySearchTool } from "./perplexity-search.js";
import {
  propertyFilterSortTool,
  propertyGetResultsTool,
  propertyGetDetailsTool,
} from "./property-operations.js";
import { addressValidatorTool } from "./address-validator.js";
import { cmaGenerateTool, cmaHistoryTool } from "./cma.js";
import {
  propertyDiscoverFieldsTool,
  propertyAnalyzeTool,
  propertyQueryTool,
} from "./property-sandbox.js";
import { collectionTools } from "./collections.js";
import { showingTools } from "./showings.js";
import { commissionTools } from "./commissions.js";

/**
 * Initialize and register all tools
 */
export function initializeTools() {
  console.log("[Tools] Initializing tools registry...");

  // Register property search tools (ES-based)
  globalToolsRegistry.register(propertySearchESTool);
  globalToolsRegistry.register(propertyDetailsTool);

  // Register property operations tools (filter, sort, get results, get details)
  globalToolsRegistry.register(propertyFilterSortTool);
  globalToolsRegistry.register(propertyGetResultsTool);
  globalToolsRegistry.register(propertyGetDetailsTool);

  // Register Perplexity search tool
  globalToolsRegistry.register(perplexitySearchTool);

  // Register address validator tool
  globalToolsRegistry.register(addressValidatorTool);

  // Register CMA tools
  globalToolsRegistry.register(cmaGenerateTool);
  globalToolsRegistry.register(cmaHistoryTool);

  // Register property sandbox tools (dynamic field discovery, analysis, query)
  globalToolsRegistry.register(propertyDiscoverFieldsTool);
  globalToolsRegistry.register(propertyAnalyzeTool);
  globalToolsRegistry.register(propertyQueryTool);

  // Register collections tools
  globalToolsRegistry.registerBatch(collectionTools);

  // Register showings tools
  globalToolsRegistry.registerBatch(showingTools);

  // Register commissions tools
  globalToolsRegistry.registerBatch(commissionTools);

  const stats = globalToolsRegistry.getStats();
  console.log(
    `[Tools] ✓ Registered ${stats.totalTools} tools: ${stats.toolNames.join(", ")}`,
  );

  return globalToolsRegistry;
}

// Export registry and individual tools
export { globalToolsRegistry };
export {
  propertySearchESTool,
  propertyDetailsTool,
} from "./property-search-es.js";
// Also export under old name for backward compatibility
export { propertySearchESTool as propertySearchTool } from "./property-search-es.js";
export {
  propertyFilterSortTool,
  propertyGetResultsTool,
  propertyGetDetailsTool,
} from "./property-operations.js";
export { perplexitySearchTool } from "./perplexity-search.js";
export { addressValidatorTool } from "./address-validator.js";
export { cmaGenerateTool, cmaHistoryTool } from "./cma.js";
export {
  propertyDiscoverFieldsTool,
  propertyAnalyzeTool,
  propertyQueryTool,
  propertySandboxTools,
} from "./property-sandbox.js";
export { collectionTools } from "./collections.js";
export { showingTools } from "./showings.js";
export { commissionTools } from "./commissions.js";
