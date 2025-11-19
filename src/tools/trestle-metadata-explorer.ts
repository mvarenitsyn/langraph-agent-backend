/**
 * Trestle Metadata Explorer Tool
 * Allows agent to execute JavaScript code to explore Trestle API schema
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";

/**
 * Trestle Metadata Explorer Tool
 *
 * Executes JavaScript code in a sandbox with access to Trestle API metadata.
 * Use this to discover field names, enum values, and validate OData filters.
 */
export const trestleMetadataExplorerTool = new DynamicStructuredTool({
  name: "trestle_metadata_explorer",
  description: `Execute JavaScript code to explore Trestle API metadata (fields, enums, validation).

**WHEN TO USE THIS TOOL:**
✓ After property_search returns 400/401 validation errors (unknown field, invalid value)
✓ When user queries mention uncommon features (wine cellar, smart home, ocean view, architectural styles)
✓ After zero-result searches that might have incorrect enum values
✓ Before complex searches with uncertain field mappings
✗ DO NOT use proactively on every search - only when validation/exploration is needed

**COMMON USE CASES:**

1. **Validation Error Recovery** - When property_search fails with "unknown field" error:
   helpers.searchFields({ resourceName: 'Property', filters: { nameContains: 'wine' }})

2. **Enum Value Discovery** - When unsure about valid PropertySubType or ArchitecturalStyle values:
   Object.keys(metadata.enums).filter(k => k.includes('StandardStatus'))
   helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.StandardStatus').values.map(v => v.value)

3. **Uncommon Feature Exploration** - When user asks about features like "smart home", "wine cellar", "ocean view":
   helpers.searchFields({ resourceName: 'Property', filters: { nameContains: 'smart' }})
   helpers.searchFields({ resourceName: 'Property', filters: { nameContains: 'view' }})

4. **Field Type Discovery** - When need to understand field data types for filtering:
   helpers.searchFields({ resourceName: 'Property', filters: { nameContains: 'price', isFilterable: true }})

5. **OData Filter Validation** - Before retry, validate filter syntax:
   helpers.validateOData({ filter: "ListPrice gt 500000 and BedroomsTotal ge 3", resourceName: "Property" })

**AVAILABLE SANDBOX OBJECTS:**
- metadata.entities: All entity definitions (Property, Office, Member, Media)
- metadata.enums: All enum types (use Object.keys(metadata.enums) to list)
- fields.getAllResources(): Get list of available resources
- helpers.searchFields(query): Search for fields by name/type/category
- helpers.getEnum(enumName): Get enum values (note: use full name like 'Cotality.DataStandard.RESO.DD.Enums.StandardStatus')
- helpers.getResource(name): Get all fields for a resource
- helpers.validateOData(req): Validate OData filter syntax

**IMPORTANT NOTES:**
- Enum names use full namespace: 'Cotality.DataStandard.RESO.DD.Enums.StandardStatus' (NOT 'RESO.StandardStatus')
- Code is executed in vm2 sandbox - do NOT use 'return' statement, just write expressions
- Results execute in ~1-5ms, safe to call multiple times during retry
- Always validate enum names first: Object.keys(metadata.enums).filter(k => k.includes('YourSearchTerm'))

**EXAMPLES:**

Find wine cellar fields:
  helpers.searchFields({ resourceName: 'Property', filters: { nameContains: 'wine' }})

Get valid property types for residential:
  Object.keys(metadata.enums).filter(k => k.includes('PropertySubType'))

Validate architectural style values:
  helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.ArchitecturalStyle').values

Check if OData filter is valid:
  helpers.validateOData({ filter: "ListPrice gt 500000", resourceName: "Property" })`,
  schema: z.object({
    code: z.string().describe("JavaScript code to execute (e.g., 'return helpers.getEnum(\"RESO.StandardStatus\")')"),
    timeout: z.number().optional().describe("Optional timeout in ms (default: 5000, max: 30000)")
  }),
  func: async ({ code, timeout }, config) => {
    console.log(`[TrestleMetadataExplorer] Executing code in sandbox...`);

    // Extract sessionId and userId from config metadata
    const sessionId = (config as any)?.metadata?.sessionId;
    const userId = (config as any)?.metadata?.userId;

    console.log(`[TrestleMetadataExplorer] SessionId: ${sessionId}, UserId: ${userId}`);

    try {
      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      // Make API request to backend sandbox service
      const response = await fetch('https://localhost:3001/api/trestle-sandbox/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          timeout: timeout || 5000
        }),
        // @ts-ignore - Node.js fetch supports agent option
        agent: httpsAgent,
      });

      console.log(`[TrestleMetadataExplorer] Response status: ${response.status}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Sandbox API returned ${response.status}: ${errorData.error || response.statusText}`);
      }

      const data = await response.json();

      if (!data.success) {
        // Sandbox execution failed - return error details
        return JSON.stringify({
          success: false,
          error: data.error?.message || 'Unknown error',
          type: data.error?.type || 'ExecutionError',
          hint: 'Check your JavaScript syntax. Available objects: metadata, fields, helpers'
        }, null, 2);
      }

      // Sandbox execution succeeded - return result
      return JSON.stringify({
        success: true,
        result: data.result,
        executionTime: data.executionTime
      }, null, 2);

    } catch (error) {
      console.error('[TrestleMetadataExplorer] Error:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return JSON.stringify({
        success: false,
        error: errorMessage,
        hint: 'Make sure the backend Trestle Sandbox Service is running'
      }, null, 2);
    }
  },
});
