/**
 * CMA (Comparative Market Analysis) Tools
 *
 * Generates professional property valuations using the CMA v2.5 backend API.
 * Uses async job queue with polling for long-running analyses.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

const BACKEND_URL = process.env.BACKEND_URL || "https://localhost:3001";

// Skip SSL verification for local development
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

interface CMAJobResponse {
  success: boolean;
  jobId: string;
  statusUrl: string;
  message: string;
}

interface CMAStatusResponse {
  jobId: string;
  listingKey: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress?: {
    percentage: number;
    currentStep: string;
    stepNumber: number;
    totalSteps: number;
  };
  reportUrl?: string;
  error?: { message: string; code: string };
  completedAt?: string;
}

interface CMAReportResponse {
  success: boolean;
  jobId: string;
  listingKey: string;
  data: {
    estimatedPrice: number;
    estimatedPPSF: number;
    lowPrice: number;
    highPrice: number;
    comps: any[];
    confidenceScore: number;
    compQuality: string;
    aiInsights?: any;
    subject?: any;
    stats?: any;
    localCompetition?: any;
    marketTrends?: any;
  };
  metadata: {
    version: string;
    generatedAt: string;
    userId: string;
  };
}

/**
 * Poll for CMA job completion
 */
async function pollCMAJob(
  jobId: string,
  userId: string,
  maxWaitMs: number = 120000, // 2 minutes max
  pollIntervalMs: number = 3000,
): Promise<CMAReportResponse | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    // Check status
    const statusRes = await fetch(
      `${BACKEND_URL}/api/v2.5/cma/status/${jobId}`,
      {
        headers: { "x-user-id": userId },
        // @ts-ignore - Node fetch supports agent
        agent: httpsAgent,
      },
    );

    if (!statusRes.ok) {
      throw new Error(`Status check failed: ${statusRes.status}`);
    }

    const status = (await statusRes.json()) as CMAStatusResponse;

    if (status.status === "completed") {
      // Fetch full report
      const reportRes = await fetch(
        `${BACKEND_URL}/api/v2.5/cma/report/${jobId}`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!reportRes.ok) {
        throw new Error(`Report fetch failed: ${reportRes.status}`);
      }

      return reportRes.json() as Promise<CMAReportResponse>;
    }

    if (status.status === "failed") {
      throw new Error(status.error?.message || "CMA generation failed");
    }

    // Log progress
    if (status.progress) {
      console.log(
        `[CMA] Progress: ${status.progress.percentage}% - ${status.progress.currentStep}`,
      );
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("CMA generation timed out");
}

/**
 * CMA Generate Tool
 *
 * Generates comprehensive property valuations via the CMA v2.5 backend.
 * Uses BullMQ job queue with polling for long-running analysis.
 */
export const cmaGenerateTool = new DynamicStructuredTool({
  name: "cma_generate",
  description: `Generate a Comparative Market Analysis (CMA) report for a property.

⚠️ PREREQUISITE: The user must be authenticated (have a userId).
CMA generation requires a valid listingKey from a property search result.

WORKFLOW:
1. User searches for properties using property_search tool
2. User identifies a property they want to analyze
3. Call cma_generate with the listingKey to get a professional valuation

This tool generates a comprehensive CMA report including:
- Estimated property value with price range
- Comparable sales analysis (recently sold similar properties)
- Market competition analysis (active/pending listings)
- Price trends (3/6/12 month)
- AI-powered market insights (neighborhood, investment potential, risks)

Use this tool when the user asks for:
- Property valuation ("What's this property worth?")
- CMA report ("Generate a CMA for this property")
- Price analysis ("How is this priced compared to market?")
- Investment analysis ("Is this a good deal?")

The report takes 30-90 seconds to generate.`,

  schema: z.object({
    listingKey: z
      .string()
      .describe("The property's ListingKey from search results"),
    enableAIInsights: z
      .boolean()
      .optional()
      .describe("Include AI-powered market insights (default: true)"),
    maxComps: z
      .number()
      .optional()
      .describe("Maximum comparable properties to analyze (default: 10)"),
    radiusMiles: z
      .number()
      .optional()
      .describe("Search radius for comparables in miles (default: 3)"),
  }),

  func: async (
    { listingKey, enableAIInsights, maxComps, radiusMiles },
    config,
  ) => {
    console.log(`[CMA] Generating CMA for listingKey: ${listingKey}`);

    // Extract user info from config
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;

    if (!userId) {
      return JSON.stringify(
        {
          success: false,
          error: "Authentication required",
          message:
            "CMA generation requires user authentication. Please log in to generate CMA reports.",
        },
        null,
        2,
      );
    }

    try {
      // Step 1: Create CMA job
      console.log(`[CMA] Creating job for user ${userId}`);
      const createRes = await fetch(`${BACKEND_URL}/api/v2.5/cma`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          listingKey,
          options: {
            enableAIInsights: enableAIInsights ?? true,
            maxComps: maxComps ?? 10,
            radiusMiles: radiusMiles ?? 3,
          },
        }),
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!createRes.ok) {
        const errorData = (await createRes
          .json()
          .catch(() => ({ error: "Unknown error" }))) as {
          error?: string;
          message?: string;
        };
        return JSON.stringify(
          {
            success: false,
            error: errorData.error || "Failed to create CMA job",
            message: errorData.message || "Unable to start CMA generation",
          },
          null,
          2,
        );
      }

      const jobData = (await createRes.json()) as CMAJobResponse;
      console.log(`[CMA] Job created: ${jobData.jobId}`);

      // Step 2: Poll for completion
      console.log(`[CMA] Polling for completion...`);
      const report = await pollCMAJob(jobData.jobId, userId);

      if (!report) {
        return JSON.stringify(
          {
            success: false,
            error: "CMA generation failed",
            message: "Unable to retrieve CMA report",
          },
          null,
          2,
        );
      }

      // Step 3: Format response for LLM
      const data = report.data;
      const formattedPrice = data.estimatedPrice.toLocaleString();
      const formattedLow = data.lowPrice.toLocaleString();
      const formattedHigh = data.highPrice.toLocaleString();

      // Build summary
      const summaryParts: string[] = [
        `## CMA Report for ${listingKey}`,
        ``,
        `**Estimated Value: $${formattedPrice}**`,
        `Price Range: $${formattedLow} - $${formattedHigh}`,
        `Price per Sq Ft: $${data.estimatedPPSF.toFixed(0)}/sqft`,
        `Confidence: ${(data.confidenceScore * 100).toFixed(0)}% (${data.compQuality})`,
        ``,
        `### Comparable Properties Used: ${data.comps.length}`,
      ];

      // Add comp summary
      if (data.comps && data.comps.length > 0) {
        summaryParts.push(`Top 3 comparables:`);
        data.comps.slice(0, 3).forEach((comp: any, i: number) => {
          const price = comp.closePrice || comp.listPrice;
          const address =
            comp.address ||
            comp.UnparsedAddress ||
            comp.unparsedAddress ||
            "Address N/A";
          summaryParts.push(
            `${i + 1}. ${address} - $${price?.toLocaleString() || "N/A"}`,
          );
        });
      }

      // Add AI insights summary if available
      if (data.aiInsights) {
        summaryParts.push(``, `### AI Market Insights Available`);
        if (data.aiInsights.neighborhoodAnalysis) {
          summaryParts.push(`- Neighborhood analysis included`);
        }
        if (data.aiInsights.investmentPotential) {
          summaryParts.push(`- Investment potential analysis included`);
        }
        if (data.aiInsights.marketConditions) {
          summaryParts.push(`- Current market conditions included`);
        }
      }

      console.log(`[CMA] ✓ Report generated successfully`);

      return JSON.stringify(
        {
          success: true,
          summary: summaryParts.join("\n"),
          jobId: report.jobId,
          listingKey: report.listingKey,
          estimatedPrice: data.estimatedPrice,
          priceRange: { low: data.lowPrice, high: data.highPrice },
          pricePerSqft: data.estimatedPPSF,
          confidenceScore: data.confidenceScore,
          compQuality: data.compQuality,
          compsCount: data.comps.length,
          hasAIInsights: !!data.aiInsights,
          reportUrl: `${BACKEND_URL}/api/v2.5/cma/report/${report.jobId}`,
          generatedAt: report.metadata.generatedAt,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[CMA] Error:", error);

      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message:
            "CMA generation failed. Please try again or contact support.",
        },
        null,
        2,
      );
    }
  },
});

/**
 * CMA History Tool
 *
 * Retrieves the user's past CMA reports for reference.
 */
export const cmaHistoryTool = new DynamicStructuredTool({
  name: "cma_history",
  description: `Get the user's CMA report history.

Use this when the user wants to:
- See their past CMA reports
- Find a previously generated valuation
- Review their CMA history`,

  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe("Number of reports to return (default: 10)"),
    offset: z.number().optional().describe("Pagination offset (default: 0)"),
  }),

  func: async ({ limit, offset }, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "cma",

          message: "Please log in to view your CMA history.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to view your CMA history.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    const actualLimit = limit ?? 10;
    const actualOffset = offset ?? 0;

    try {
      const res = await fetch(
        `${BACKEND_URL}/api/v2.5/cma/history?limit=${actualLimit}&offset=${actualOffset}`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!res.ok) {
        throw new Error(`Failed to fetch history: ${res.status}`);
      }

      const data = (await res.json()) as {
        jobs: any[];
        pagination: { total: number; hasMore: boolean };
      };

      // Format for LLM
      const jobsSummary = data.jobs.map((job: any) => ({
        jobId: job.jobId,
        listingKey: job.listingKey,
        status: job.status,
        address: job.propertyData?.address || job.propertyData?.UnparsedAddress,
        city: job.propertyData?.city || job.propertyData?.City,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      }));

      return JSON.stringify(
        {
          success: true,
          jobs: jobsSummary,
          totalCount: data.pagination.total,
          hasMore: data.pagination.hasMore,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[CMA History] Error:", error);

      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        null,
        2,
      );
    }
  },
});
