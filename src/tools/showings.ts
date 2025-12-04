/**
 * Showings Tools
 *
 * Manage property showing requests via backend API.
 * Allows creating, listing, rescheduling, and canceling showings.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

const BACKEND_URL = process.env.BACKEND_URL || "https://localhost:3001";

// Skip SSL verification for local development
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Showing Create Tool
 *
 * Create a new showing request for a property.
 */
export const showingCreateTool = new DynamicStructuredTool({
  name: "showing_create",
  description: `Create a showing request for a property.

⚠️ PREREQUISITE: The user must be authenticated (have a userId).

Use this when the user wants to:
- Schedule a property showing
- Request to see a property
- Book a property tour

Examples:
- "schedule a showing for this property"
- "I want to see this property tomorrow"
- "book a tour for this listing"`,

  schema: z.object({
    listingKey: z.string().describe("Property ListingKey from search results"),
    preferredDate: z
      .string()
      .describe(
        "Preferred date in ISO format (YYYY-MM-DD) or relative (tomorrow, next week)",
      ),
    preferredTimeSlot: z
      .enum(["morning", "afternoon", "evening"])
      .optional()
      .describe("Preferred time of day"),
    notes: z
      .string()
      .optional()
      .describe("Additional notes or special requests"),
  }),

  func: async (
    { listingKey, preferredDate, preferredTimeSlot, notes },
    config,
  ) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "showings",

          message: "Please log in to schedule showings.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to schedule showings.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      // Parse relative dates
      let isoDate = preferredDate;
      if (preferredDate.toLowerCase() === "tomorrow") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        isoDate = tomorrow.toISOString().split("T")[0];
      } else if (preferredDate.toLowerCase().includes("next week")) {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        isoDate = nextWeek.toISOString().split("T")[0];
      }

      const response = await fetch(`${BACKEND_URL}/api/showings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          listingKey,
          preferredDate: isoDate,
          preferredTimeSlot,
          notes,
        }),
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to create showing" }))) as any;
        return JSON.stringify(
          {
            success: false,
            error: error.error || "Failed to create showing",
            message: error.message || "Unable to schedule showing",
          },
          null,
          2,
        );
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          showingId: data.id,
          status: data.status,
          propertyAddress: data.property_address || data.propertyAddress,
          preferredDate: data.preferred_date || data.preferredDate,
          timeSlot: data.preferred_time_slot || data.preferredTimeSlot,
          message: `Showing request created successfully. Status: ${data.status}`,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Showing Create] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to create showing request. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Showing List Tool
 *
 * List user's showing requests.
 */
export const showingListTool = new DynamicStructuredTool({
  name: "showing_list",
  description: `List user's property showing requests.

Use this when the user wants to:
- See their scheduled showings
- Check showing status
- View upcoming showings

Examples:
- "what showings do I have?"
- "show my upcoming property tours"
- "list my scheduled showings"`,

  schema: z.object({
    status: z
      .enum(["pending", "confirmed", "cancelled", "completed"])
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

          feature: "showings",

          message: "Please log in to view showings.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to view showings.",

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

      const response = await fetch(`${BACKEND_URL}/api/showings?${params}`, {
        headers: { "x-user-id": userId },
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch showings: ${response.status}`);
      }

      const data = (await response.json()) as any;
      const showings = data.showings || [];

      return JSON.stringify(
        {
          success: true,
          showings: showings.map((s: any) => ({
            id: s.id,
            listingKey: s.listing_key || s.listingKey,
            propertyAddress: s.property_address || s.propertyAddress,
            status: s.status,
            preferredDate: s.preferred_date || s.preferredDate,
            scheduledAt: s.scheduled_at || s.scheduledAt,
            timeSlot: s.preferred_time_slot || s.preferredTimeSlot,
            createdAt: s.created_at || s.createdAt,
          })),
          totalCount: data.total || showings.length,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Showing List] Error:", error);
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
 * Showing Get Tool
 *
 * Get details for a specific showing.
 */
export const showingGetTool = new DynamicStructuredTool({
  name: "showing_get",
  description: `Get detailed information about a specific showing.

Use this when the user wants to:
- See details of a showing
- Check showing status
- Get showing information

Examples:
- "show me details of my showing"
- "what's the status of my showing?"`,

  schema: z.object({
    showingId: z.string().describe("Showing ID"),
  }),

  func: async ({ showingId }, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "showings",

          message: "Please log in to view showing details.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to view showing details.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/showings/${showingId}`, {
        headers: { "x-user-id": userId },
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return JSON.stringify(
            {
              success: false,
              error: "Showing not found",
              message: "Showing does not exist or you do not have access.",
            },
            null,
            2,
          );
        }
        throw new Error(`Failed to fetch showing: ${response.status}`);
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          showing: {
            id: data.id,
            listingKey: data.listing_key || data.listingKey,
            propertyAddress: data.property_address || data.propertyAddress,
            status: data.status,
            preferredDate: data.preferred_date || data.preferredDate,
            scheduledAt: data.scheduled_at || data.scheduledAt,
            timeSlot: data.preferred_time_slot || data.preferredTimeSlot,
            notes: data.notes,
            createdAt: data.created_at || data.createdAt,
            updatedAt: data.updated_at || data.updatedAt,
          },
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Showing Get] Error:", error);
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
 * Showing Reschedule Tool
 *
 * Request to reschedule a showing to a new date/time.
 */
export const showingRescheduleTool = new DynamicStructuredTool({
  name: "showing_reschedule",
  description: `Request to reschedule a showing to a different date/time.

Use this when the user wants to:
- Change showing date
- Reschedule a tour
- Move a showing to different time

Examples:
- "reschedule my showing to next week"
- "change my showing to tomorrow afternoon"
- "move my tour to a different day"`,

  schema: z.object({
    showingId: z.string().describe("Showing ID to reschedule"),
    newDate: z
      .string()
      .describe("New preferred date in ISO format (YYYY-MM-DD) or relative"),
    newTimeSlot: z
      .enum(["morning", "afternoon", "evening"])
      .optional()
      .describe("New preferred time of day"),
    reason: z.string().optional().describe("Reason for rescheduling"),
  }),

  func: async ({ showingId, newDate, newTimeSlot, reason }, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "showings",

          message: "Please log in to reschedule showings.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to reschedule showings.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      // Parse relative dates
      let isoDate = newDate;
      if (newDate.toLowerCase() === "tomorrow") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        isoDate = tomorrow.toISOString().split("T")[0];
      } else if (newDate.toLowerCase().includes("next week")) {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        isoDate = nextWeek.toISOString().split("T")[0];
      }

      const response = await fetch(
        `${BACKEND_URL}/api/showings/${showingId}/reschedule`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
          },
          body: JSON.stringify({
            newDate: isoDate,
            newTimeSlot,
            reason,
          }),
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to reschedule" }))) as any;
        return JSON.stringify(
          {
            success: false,
            error: error.error || "Failed to reschedule showing",
            message: error.message || "Unable to reschedule showing",
          },
          null,
          2,
        );
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          showingId: data.id,
          status: data.status,
          newDate: isoDate,
          newTimeSlot,
          message: "Showing reschedule request submitted successfully",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Showing Reschedule] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to reschedule showing. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Showing Cancel Tool
 *
 * Cancel a showing request.
 */
export const showingCancelTool = new DynamicStructuredTool({
  name: "showing_cancel",
  description: `Cancel a showing request.

Use this when the user wants to:
- Cancel a scheduled showing
- Cancel a property tour
- Remove a showing

Examples:
- "cancel my showing"
- "cancel tomorrow's property tour"
- "I need to cancel my showing"`,

  schema: z.object({
    showingId: z.string().describe("Showing ID to cancel"),
    reason: z.string().optional().describe("Reason for cancellation"),
  }),

  func: async ({ showingId, reason }, config) => {
    const userId = (config as any)?.metadata?.userId;

    const sessionId = (config as any)?.metadata?.sessionId;

    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event

      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",

          feature: "showings",

          message: "Please log in to cancel showings.",

          sessionId,

          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,

          error: "Authentication required",

          message: "Please log in to cancel showings.",

          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/showings/${showingId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({ reason }),
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return JSON.stringify(
            {
              success: false,
              error: "Showing not found",
              message: "Showing does not exist or you do not have access.",
            },
            null,
            2,
          );
        }
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to cancel" }))) as any;
        return JSON.stringify(
          {
            success: false,
            error: error.error || "Failed to cancel showing",
            message: error.message || "Unable to cancel showing",
          },
          null,
          2,
        );
      }

      const data = await response.json();

      return JSON.stringify(
        {
          success: true,
          showingId,
          message: "Showing cancelled successfully",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Showing Cancel] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to cancel showing. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

// Export all tools as array
export const showingTools = [
  showingCreateTool,
  showingListTool,
  showingGetTool,
  showingRescheduleTool,
  showingCancelTool,
];
