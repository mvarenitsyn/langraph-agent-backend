import { HumanMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createReflectionModel } from "../models/openai.js";
import { ReflectionOutput } from "../types/reflection.js";

/**
 * Reflect Node - Second step in RRR pattern
 *
 * Analyzes the tool results and agent's reasoning to determine if:
 * 1. The results are sufficient and high-quality
 * 2. More information is needed (should retry)
 * 3. The results have errors or issues
 */

export async function reflectNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Reflect] Analyzing tool results and reasoning...');

  try {
    const model = createReflectionModel();

    // Build reflection prompt
    const reflectionPrompt = `
You are a quality assurance analyst reviewing tool execution results for a real estate AI assistant.

**User Message:** ${state.message}

**Tool Results:**
${JSON.stringify(state.toolResults, null, 2)}

**Previous Messages:**
${state.messages.map(m => `${m._getType()}: ${m.content}`).join('\n')}


# ANALYSIS TASK

Review the tool results above and provide your assessment:

1. **Which tool(s) were called?** Identify the tool(s) from the results
2. **Did each tool succeed?** Check if success=true in the tool result. DO NOT assume errors based on totalCount=0 alone.
3. **Is the information sufficient to answer the user's query?** Consider completeness
4. **Are there quality issues?** Missing data, errors, low relevance, etc.
5. **Should we retry?** Only if quality is LOW and retry could improve results

**IMPORTANT: Understanding Tool Results**
- property_search with success=true and totalCount=0 means NO properties matched the criteria - this is NOT an error or API failure
- **Validation errors (validationError=true)**: OData filter syntax is invalid or uses unsupported fields - retry with SIMPLER criteria
- **Auth errors (authError=true)**: Authentication token expired - backend will refresh automatically on retry
- **Real server errors (500)**: Actual API/service failures - these should throw exceptions and terminate the workflow
- 0 results can be a valid outcome that should trigger retry with relaxed filters (expand status, broaden location)

Provide structured analysis with:
- Quality assessment (HIGH/MEDIUM/LOW)
- Completeness level (COMPLETE/PARTIAL/INSUFFICIENT)
- Specific issues or "None"
- Recommendation (PROCEED/RETRY/ERROR)
- Brief reasoning (max 250 characters)
- If RETRY: recovery strategy with specific actionable guidance
- If RETRY: issue analysis explaining what went wrong (DO NOT mention "500 error" unless there's an actual HTTP error)

**Recovery Strategy Guidelines - PRIORITY ORDER:**

**For Validation Errors (validationError=true):**
- **FIRST: Use trestle_metadata_explorer** to validate field names and enum values
  * If error mentions "unknown field" → helpers.searchFields({resourceName: 'Property', filters: {nameContains: 'field_keyword'}})
  * If error mentions invalid enum value → Object.keys(metadata.enums).filter(k => k.includes('EnumName'))
  * Validate specific enum values → helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.EnumName').values
- **THEN: SIMPLIFY** the search criteria - remove complex filters, use broader location, reduce number of criteria
- The OData filter syntax is invalid or uses unsupported field values
- DO NOT expand - this will make the error worse

**For Auth Errors (authError=true):**
- Just retry - backend will refresh the authentication token automatically
- No need to modify search criteria

**For Zero Results (totalCount=0):**
1. **FIRST PRIORITY - Validate Enum Values with trestle_metadata_explorer**:
   - **ALWAYS use trestle_metadata_explorer BEFORE modifying OData filters**
   - Validate StandardStatus enum values: helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.StandardStatus').values.map(v => v.value)
   - Validate PropertySubType if present: helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.PropertySubType').values
   - Check field names if query has uncommon features: helpers.searchFields({resourceName: 'Property', filters: {nameContains: 'keyword'}})
   - Example: Before expanding StandardStatus, verify correct enum values (e.g., "ActiveUnderContract" NOT "Active Under Contract")

2. **SECOND PRIORITY - Simplify Location Criteria**:
   - Remove unit numbers from StreetNumber or UnitNumber fields
   - Simplify to just street + city + zip
   - Example: "1000 W Island Blvd Apt 2309" → "1000 W Island Blvd"

3. **THIRD PRIORITY - Broaden Search Area**:
   - Relax address filters (remove StreetNumber, keep only StreetName + City)
   - Expand to nearby areas or county

4. **FOURTH PRIORITY - Remove StandardStatus Filter Entirely**:
   - Remove StandardStatus filter completely from OData query to search ALL listing statuses
   - This includes Active, Expired, Canceled, Closed, Pending, Withdrawn, Hold, ComingSoon, etc.
   - Historical listings (Expired/Canceled) often represent 70%+ of MLS data
   - Only keep location/property filters (StreetName, City, PostalCode, PropertyType, etc.)

5. **LAST RESORT - Web Search**:
   - Only use perplexity_search if MLS data truly doesn't exist
   - This should be the FINAL fallback, not the first option

`;

    // Invoke model and get structured response
    const reflection = await model.invoke([
      new HumanMessage({ content: reflectionPrompt }),
    ]) as ReflectionOutput;

    console.log('[Reflect] Analysis complete');
    console.log('[Reflect] Quality:', reflection.qualityAssessment);
    console.log('[Reflect] Completeness:', reflection.completeness);
    console.log('[Reflect] Recommendation:', reflection.recommendation);
    if (reflection.issues !== 'None') {
      console.log('[Reflect] Issues:', reflection.issues);
    }
    if (reflection.recoveryStrategy && reflection.recoveryStrategy !== '') {
      console.log('[Reflect] Recovery Strategy:', reflection.recoveryStrategy);
    }
    if (reflection.issueAnalysis && reflection.issueAnalysis !== '') {
      console.log('[Reflect] Issue Analysis:', reflection.issueAnalysis);
    }

    // CRITICAL: Force RETRY if property_search returned 0 results
    // This overrides the LLM's recommendation to ensure we always retry zero-result searches
    // BUT only if we haven't exceeded max retries
    let finalRecommendation = reflection.recommendation;
    let finalRecoveryStrategy = reflection.recoveryStrategy;
    let finalIssueAnalysis = reflection.issueAnalysis;
    let extractedOdataFilter: string | null = null;

    // Get current retry count from state
    const currentRetryCount = state.retryCount || 0;
    const maxRetries = state.maxRetries || 3;

    if (state.toolResults) {
      // Check if property_search was called and returned 0 results
      for (const [toolName, result] of Object.entries(state.toolResults)) {
        if (toolName === 'property_search' && result) {
          const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;

          // CRITICAL: Extract odataFilter from property_search results for retry use
          if (parsedResult.odataFilter) {
            extractedOdataFilter = parsedResult.odataFilter;
            console.log(`[Reflect] 📋 Extracted OData filter for retry: ${extractedOdataFilter}`);
          }

          // CRITICAL: Check for validation errors FIRST (highest priority)
          if (parsedResult.validationError === true) {
            // Only retry if we haven't exceeded max retries
            if (currentRetryCount < maxRetries) {
              console.log(`[Reflect] ⚠️  VALIDATION ERROR detected - FORCING RETRY with simplification (${currentRetryCount}/${maxRetries})`);
              finalRecommendation = 'RETRY';
              finalRecoveryStrategy = 'Simplify search criteria - remove complex filters, use broader location, reduce number of criteria. The OData filter syntax is invalid or uses unsupported field values.';
              finalIssueAnalysis = 'OData filter validation failed. The query syntax is too complex or uses invalid field values.';
            } else {
              console.log(`[Reflect] ⚠️  Max retries reached on validation error (${currentRetryCount}/${maxRetries}) - allowing PROCEED`);
              finalRecommendation = 'PROCEED';
              finalIssueAnalysis = 'Unable to construct valid search query after multiple attempts. The search criteria may be too specific or use unsupported filters.';
            }
            break;
          }

          // CRITICAL: Check for auth errors (should auto-retry with refreshed token)
          if (parsedResult.authError === true) {
            // Only retry if we haven't exceeded max retries
            if (currentRetryCount < maxRetries) {
              console.log(`[Reflect] ⚠️  AUTH ERROR detected - FORCING RETRY (backend will refresh token) (${currentRetryCount}/${maxRetries})`);
              finalRecommendation = 'RETRY';
              finalRecoveryStrategy = 'Retry search (authentication token will be refreshed automatically by backend)';
              finalIssueAnalysis = 'Authentication token expired. Retrying with refreshed credentials.';
            } else {
              console.log(`[Reflect] ⚠️  Max retries reached on auth error (${currentRetryCount}/${maxRetries}) - allowing PROCEED`);
              finalRecommendation = 'PROCEED';
              finalIssueAnalysis = 'Authentication failed after multiple retry attempts. Please contact support.';
            }
            break;
          }

          if (parsedResult.totalCount === 0) {
            // Only force RETRY if we haven't exceeded max retries
            if (currentRetryCount < maxRetries) {
              console.log(`[Reflect] ⚠️  CRITICAL: property_search returned 0 results - FORCING RETRY (${currentRetryCount}/${maxRetries})`);
              finalRecommendation = 'RETRY';

              // Progressive recovery strategy based on retry count
              if (!finalRecoveryStrategy) {
                if (currentRetryCount === 0) {
                  // Retry 1: Validate enums and remove StreetNumber
                  finalRecoveryStrategy = 'FIRST: Use trestle_metadata_explorer to validate StandardStatus enum values: helpers.getEnum("Cotality.DataStandard.RESO.DD.Enums.StandardStatus").values.map(v => v.value). THEN: Remove StreetNumber filter and keep StreetName, City, PostalCode for broader street-level search.';
                  finalIssueAnalysis = 'Property not found with exact street number. Need to validate enum values and broaden search to entire street.';
                } else if (currentRetryCount === 1) {
                  // Retry 2: Drop unit number and address suffixes/directions
                  finalRecoveryStrategy = 'Remove UnitNumber filter and simplify address by dropping street directions/suffixes (W/E/N/S, Blvd/St/Ave). These fields are not reliable in MLS. Keep StreetName, City, PostalCode.';
                  finalIssueAnalysis = 'Property not found with unit number or address suffixes. Simplifying to basic street name + area.';
                } else if (currentRetryCount === 2) {
                  // Retry 3: Remove StandardStatus filter entirely to search ALL listing statuses
                  finalRecoveryStrategy = 'Remove StandardStatus filter completely from the OData filter to search ALL listing statuses (Active, Expired, Canceled, Closed, Pending, Withdrawn, Hold, etc.). This ensures we find properties regardless of their current MLS status. Keep all other location/property filters (StreetName, City, PostalCode).';
                  finalIssueAnalysis = 'Property not found with status-restricted search. StandardStatus filter may be excluding valid results (e.g., Expired, Canceled listings which represent 70%+ of historical data). Removing status filter to search entire MLS history.';
                }
              }

              console.log('[Reflect] → Recovery Strategy:', finalRecoveryStrategy);
              console.log('[Reflect] → Issue Analysis:', finalIssueAnalysis);
            } else {
              // Max retries reached - allow PROCEED with 0 results
              console.log(`[Reflect] ⚠️  Max retries reached (${currentRetryCount}/${maxRetries}) - allowing PROCEED with 0 results`);
              finalRecommendation = 'PROCEED';
              finalIssueAnalysis = 'Property not found after expanding search criteria and retrying. The property may not exist in MLS.';
            }
            break;
          }
        }
      }
    }

    return {
      reflection: JSON.stringify(reflection), // Store full structured reflection for debugging
      metadata: {
        ...state.metadata,
        reflectionRecommendation: finalRecommendation,
        recoveryStrategy: (finalRecoveryStrategy && finalRecoveryStrategy !== '') ? finalRecoveryStrategy : undefined,
        issueAnalysis: (finalIssueAnalysis && finalIssueAnalysis !== '') ? finalIssueAnalysis : undefined,
        previousOdataFilter: extractedOdataFilter || undefined, // Pass odataFilter to router for LLM-based modification
      },
    };
  } catch (error) {
    console.error('[Reflect] ✗ Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Reflection failed',
    };
  }
}
