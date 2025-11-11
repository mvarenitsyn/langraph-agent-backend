import { HumanMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createReflectionModel } from "../models/openai.js";

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

Analyze the results using tool-specific success criteria:

# TOOL SUCCESS CRITERIA

## 1. property_search
**Purpose:** Natural language property search that returns summary + searchToken for map viewing
**Returns:** { success: boolean, summary: string, totalCount: number, searchToken: string|null, mapLink: string|null, queryMetadata: object }
**Success Criteria:**
  ✓ success = true
  ✓ totalCount > 0 (found matching properties)
  ✓ searchToken is present (allows user to view results on map)
  ✓ summary provides useful information about the search results
**Failure Indicators:**
  ✗ success = false or API error
  ✗ totalCount = 0 (no properties found - may need to broaden search or try different query)
  ✗ Missing searchToken (API issue)
**Quality Levels:**
  - HIGH: totalCount > 50, has searchToken, clear summary with query type/intent
  - MEDIUM: totalCount 1-50, has searchToken, basic summary
  - LOW: totalCount = 0 OR missing searchToken OR API errors
**Retry Scenarios:**
  - If totalCount = 0, recommend RETRY with broader criteria or different location
  - If API error (success=false), recommend RETRY once
  - If searchToken missing but totalCount > 0, still PROCEED (data issue but user got count)

## 2. property_details
**Purpose:** Get detailed information about a specific property by ID
**Returns:** { success: boolean, message?: string, details?: object }
**Success Criteria:**
  ✓ success = true
  ✓ Property details object is present with key information
**Failure Indicators:**
  ✗ success = false
  ✗ "not yet implemented" message (tool under development)
**Quality Levels:**
  - HIGH: Complete property details with all fields
  - MEDIUM: Partial property details
  - LOW: Not implemented or error
**Retry Scenarios:**
  - If not implemented, PROCEED with explanation to user
  - If error, recommend RETRY once

## 3. perplexity_search
**Purpose:** Web search using Perplexity AI for real-time information with citations
**Returns:** { success: boolean, answer: string, citations: string[], usage?: object, error?: string }
**Success Criteria:**
  ✓ success = true
  ✓ answer is present and substantive (not "No answer received")
  ✓ citations array has at least 1-2 sources
**Failure Indicators:**
  ✗ success = false or error message present
  ✗ API key not configured
  ✗ Empty or generic answer without specific information
  ✗ No citations (reduces credibility)
**Quality Levels:**
  - HIGH: Detailed answer with 3+ citations, specific data/facts
  - MEDIUM: Good answer with 1-2 citations, relevant information
  - LOW: Generic answer OR no citations OR API error
**Retry Scenarios:**
  - If API key not configured, PROCEED but note limitation to user
  - If API error, recommend RETRY once
  - If answer is too generic, consider RETRY with more specific query

## 4. perplexity_real_estate_research
**Purpose:** Real estate market research using Perplexity with focus on trusted real estate sources
**Returns:** { success: boolean, answer: string, citations: string[], usage?: object }
**Success Criteria:**
  ✓ success = true
  ✓ answer provides market-specific insights (trends, prices, neighborhoods)
  ✓ citations include real estate sources (zillow, realtor.com, redfin, forbes, wsj, bloomberg)
**Failure Indicators:**
  ✗ success = false or error
  ✗ Generic answer without market data
  ✗ Missing citations from real estate sources
**Quality Levels:**
  - HIGH: Market data with stats/trends, 3+ citations from real estate domains
  - MEDIUM: Relevant market info, 1-2 citations
  - LOW: Generic info OR no real estate citations OR API error
**Retry Scenarios:**
  - Same as perplexity_search
  - If answer lacks market-specific data, consider RETRY with refined query

# ANALYSIS TASK

Review the tool results above and provide your assessment:

1. **Which tool(s) were called?** Identify the tool(s) from the results
2. **Did each tool succeed according to its criteria?** Apply tool-specific success criteria
3. **Is the information sufficient to answer the user's query?** Consider completeness
4. **Are there quality issues?** Missing data, errors, low relevance, etc.
5. **Should we retry?** Only if quality is LOW and retry could improve results

**Output Format:**
- **Quality Assessment:** [HIGH/MEDIUM/LOW]
- **Completeness:** [COMPLETE/PARTIAL/INSUFFICIENT]
- **Issues:** [List specific problems or "None"]
- **Recommendation:** [PROCEED/RETRY/ERROR]
- **Reasoning:** [Brief explanation referencing tool criteria, max 250 characters]

`;

    const response = await model.invoke([
      new HumanMessage({ content: reflectionPrompt }),
    ]);

    const reflection = response.content as string;
    console.log('[Reflect] Analysis complete');
    console.log(reflection);

    // Parse recommendation
    const recommendationMatch = reflection.match(/\*\*Recommendation:\*\*\s*\[(\w+)\]/i);
    const recommendation = recommendationMatch ? recommendationMatch[1].toUpperCase() : 'PROCEED';

    return {
      reflection,
      metadata: {
        ...state.metadata,
        reflectionRecommendation: recommendation,
      },
    };
  } catch (error) {
    console.error('[Reflect] ✗ Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Reflection failed',
    };
  }
}
