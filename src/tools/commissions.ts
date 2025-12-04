/**
 * Commissions Tools
 *
 * Manage commission requests via backend API.
 * Allows requesting and tracking commission information from listing agents.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

const BACKEND_URL = process.env.BACKEND_URL || "https://localhost:3001";

// Skip SSL verification for local development
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Commission Request Tool
 *
 * Request commission information from a listing agent.
 */
export const commissionRequestTool = new DynamicStructuredTool({
  name: "commission_request",
  description: `Request commission information from a listing agent.

⚠️ PREREQUISITE: The user must be authenticated (have a userId).

Use this when the user wants to:
- Request commission info for a property
- Ask about buyer agent commission
- Inquire about compensation

Examples:
- "request commission info for this property"
- "what's the buyer agent commission?"
- "inquire about commission"`,

  schema: z.object({
    listingKey: z.string().describe("Property ListingKey from search results"),
    propertyAddress: z.string().describe("Property address for context"),
    message: z
      .string()
      .optional()
      .describe("Optional message to the listing agent"),
  }),

  func: async ({ listingKey, propertyAddress, message }, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "commissions",

          message: "Please log in to request commission information.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to request commission information.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/commission`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          listingKey,
          propertyAddress,
          message,
        }),
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to create request" }))) as any;
        return JSON.stringify(
          {
            success: false,
            error: error.error || "Failed to create commission request",
            message:
              error.message || "Unable to request commission information",
          },
          null,
          2,
        );
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          requestId: data.id,
          status: data.status,
          propertyAddress: data.property_address || data.propertyAddress,
          message:
            "Commission request sent successfully. The listing agent will be notified.",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Commission Request] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to create commission request. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Commission List Tool
 *
 * List user's commission requests.
 */
export const commissionListTool = new DynamicStructuredTool({
  name: "commission_list",
  description: `List user's commission requests.

Use this when the user wants to:
- See their commission requests
- Check commission request status
- View commission responses

Examples:
- "show my commission requests"
- "what commission requests are pending?"
- "list my commission inquiries"`,

  schema: z.object({
    status: z
      .enum(["pending", "responded", "declined"])
      .optional()
      .describe("Filter by status"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number to return (default: 20)"),
  }),

  func: async ({ status, limit }, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "commissions",

          message: "Please log in to view commission requests.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to view commission requests.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const params = new URLSearchParams();
      if (status) params.append("status", status);
      if (limit) params.append("limit", limit.toString());

      const response = await fetch(
        `${BACKEND_URL}/api/commission/user?${params}`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch commission requests: ${response.status}`,
        );
      }

      const data = (await response.json()) as any;
      const requests = data.requests || [];

      return JSON.stringify(
        {
          success: true,
          requests: requests.map((r: any) => ({
            id: r.id,
            listingKey: r.listing_key || r.listingKey,
            propertyAddress: r.property_address || r.propertyAddress,
            status: r.status,
            commission: r.commission,
            commissionType: r.commission_type || r.commissionType,
            agentResponse: r.agent_response || r.agentResponse,
            isRead: r.is_read || r.isRead,
            createdAt: r.created_at || r.createdAt,
            respondedAt: r.responded_at || r.respondedAt,
          })),
          totalCount: data.total || requests.length,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Commission List] Error:", error);
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

/**
 * Commission Unread Count Tool
 *
 * Get count of unread commission responses.
 */
export const commissionUnreadCountTool = new DynamicStructuredTool({
  name: "commission_unread_count",
  description: `Get count of unread commission responses.

Use this when the user wants to:
- Check for new commission responses
- See if agents have responded
- Check notification count

Examples:
- "do I have any commission responses?"
- "any new commission info?"
- "check for commission updates"`,

  schema: z.object({}),

  func: async (args, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "commissions",

          message: "Please log in to check commission updates.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to check commission updates.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/commission/unread-count`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch unread count: ${response.status}`);
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          unreadCount: data.unreadCount || data.unread_count || 0,
          message:
            data.unreadCount > 0
              ? `You have ${data.unreadCount} unread commission response${data.unreadCount === 1 ? "" : "s"}`
              : "No new commission responses",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Commission Unread Count] Error:", error);
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

// Export all tools as array
export const commissionTools = [
  commissionRequestTool,
  commissionListTool,
  commissionUnreadCountTool,
];
