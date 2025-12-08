/**
 * Showings Tools
 *
 * Manage property showing requests via backend API.
 * Allows creating, listing, rescheduling, and canceling showings.
 *
 * Uses the MLS endpoint (/api/showings/mls) for properties from search results
 * since we work with listing keys, not internal UUIDs.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

const BACKEND_URL = process.env.BACKEND_URL || "https://localhost:3001";

// Skip SSL verification for local development
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Helper to convert time slot to time window
 */
function getTimeWindow(timeSlot: string): { start: string; end: string } {
  switch (timeSlot) {
    case "morning":
      return { start: "09:00", end: "12:00" };
    case "afternoon":
      return { start: "12:00", end: "17:00" };
    case "evening":
      return { start: "17:00", end: "20:00" };
    default:
      return { start: "10:00", end: "14:00" }; // Default 4-hour window
  }
}

/**
 * Helper to parse relative dates
 */
function parseDate(dateStr: string): string {
  const lower = dateStr.toLowerCase().trim();
  const now = new Date();

  if (lower === "today") {
    return now.toISOString().split("T")[0];
  }
  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    return now.toISOString().split("T")[0];
  }
  if (lower.includes("next week")) {
    now.setDate(now.getDate() + 7);
    return now.toISOString().split("T")[0];
  }
  // Check for day names (e.g., "next monday", "this friday")
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < dayNames.length; i++) {
    if (lower.includes(dayNames[i])) {
      const currentDay = now.getDay();
      let daysToAdd = i - currentDay;
      if (daysToAdd <= 0 || lower.includes("next")) {
        daysToAdd += 7;
      }
      now.setDate(now.getDate() + daysToAdd);
      return now.toISOString().split("T")[0];
    }
  }

  // If it looks like YYYY-MM-DD, return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Default to tomorrow if can't parse
  now.setDate(now.getDate() + 1);
  return now.toISOString().split("T")[0];
}

/**
 * Showing Create Tool
 *
 * Create a new showing request for a property using the MLS endpoint.
 */
export const showingCreateTool = new DynamicStructuredTool({
  name: "showing_create",
  description: `Create a showing request for a property.

⚠️ PREREQUISITE: The user must be authenticated (have a userId).

Use this when the user wants to:
- Schedule a property showing
- Request to see a property
- Book a property tour

Parameters:
- listingKey: Property ListingKey/MLS ID from search results (REQUIRED)
- propertyAddress: Full property address (REQUIRED)
- showingDate: Date for the showing - can be "tomorrow", "next week", "next monday", or YYYY-MM-DD format
- timeSlot: "morning" (9am-12pm), "afternoon" (12pm-5pm), or "evening" (5pm-8pm)
- durationMinutes: How long the showing should be (default: 30)
- notes: Any special requests or notes

Examples:
- "schedule a showing for property 1234567 tomorrow afternoon"
- "I want to see 123 Main St next Monday morning"
- "book a tour for this listing"`,

  schema: z.object({
    listingKey: z.string().describe("Property ListingKey/MLS ID from search results"),
    propertyAddress: z.string().describe("Full property address"),
    showingDate: z
      .string()
      .describe("Showing date - can be 'tomorrow', 'next week', 'next monday', or YYYY-MM-DD format"),
    timeSlot: z
      .enum(["morning", "afternoon", "evening"])
      .optional()
      .describe("Time of day: morning (9am-12pm), afternoon (12pm-5pm), evening (5pm-8pm)"),
    durationMinutes: z
      .number()
      .optional()
      .describe("Duration in minutes (default: 30, min: 15, max: 240)"),
    notes: z.string().optional().describe("Additional notes or special requests"),
  }),

  func: async (
    { listingKey, propertyAddress, showingDate, timeSlot, durationMinutes, notes },
    config,
  ) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
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
      // Parse the date
      const isoDate = parseDate(showingDate);

      // Get time window from slot
      const timeWindow = getTimeWindow(timeSlot || "afternoon");

      // Build request body for MLS endpoint
      const requestBody = {
        listingId: listingKey,
        propertyMlsId: listingKey,
        propertyAddress,
        showingDate: isoDate,
        timeWindowStart: timeWindow.start,
        timeWindowEnd: timeWindow.end,
        durationMinutes: durationMinutes || 30,
        bufferMinutes: 15,
        allowAgentReschedule: true,
        notes: notes || undefined,
      };

      console.log("[Showing Create] Calling MLS endpoint with:", requestBody);

      const response = await fetch(`${BACKEND_URL}/api/showings/mls`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify(requestBody),
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to create showing" }))) as any;
        console.error("[Showing Create] Backend error:", error);
        return JSON.stringify(
          {
            success: false,
            error: error.error?.message || error.error || "Failed to create showing",
            details: error.error?.details || undefined,
            message: "Unable to schedule showing. Please check the parameters.",
          },
          null,
          2,
        );
      }

      const data = (await response.json()) as any;
      const showing = data.data?.showing || data.showing || data;

      return JSON.stringify(
        {
          success: true,
          showingId: showing.id,
          status: showing.status,
          propertyAddress: showing.property_address || propertyAddress,
          showingDate: showing.showing_date || isoDate,
          timeWindow: `${timeWindow.start} - ${timeWindow.end}`,
          durationMinutes: showing.duration_minutes || durationMinutes || 30,
          message: `Showing request created successfully. Status: ${showing.status}. The listing agent will be notified.`,
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
      .enum([
        "pending_owner_confirmation",
        "pending_requester_confirmation",
        "confirmed",
        "suggested_reschedule",
        "cancelled_by_requester",
        "cancelled_by_owner",
        "completed",
        "expired",
      ])
      .optional()
      .describe("Filter by status"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number to return (default: 20, max: 100)"),
  }),

  func: async ({ status, limit }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
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

      const responseData = (await response.json()) as any;
      // Backend returns { success: true, data: { showings: [...], count: N } }
      const showings = responseData.data?.showings || responseData.showings || [];

      return JSON.stringify(
        {
          success: true,
          showings: showings.map((s: any) => ({
            id: s.id,
            listingKey: s.property_mls_id || s.listing_key || s.listingKey,
            propertyAddress: s.property_address || s.propertyAddress,
            status: s.status,
            showingDate: s.showing_date || s.showingDate,
            timeWindow: s.time_window_start && s.time_window_end
              ? `${s.time_window_start} - ${s.time_window_end}`
              : null,
            scheduledAt: s.scheduled_at || s.scheduledAt,
            durationMinutes: s.duration_minutes || s.durationMinutes,
            listingAgentName: s.listing_agent_name || s.listingAgentName,
            listingAgentEmail: s.listing_agent_email || s.listingAgentEmail,
            notes: s.notes,
            createdAt: s.created_at || s.createdAt,
          })),
          totalCount: responseData.data?.count || showings.length,
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
    showingId: z.string().describe("Showing ID (UUID)"),
  }),

  func: async ({ showingId }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
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

      const responseData = (await response.json()) as any;
      const s = responseData.data?.showing || responseData.showing || responseData;

      return JSON.stringify(
        {
          success: true,
          showing: {
            id: s.id,
            listingKey: s.property_mls_id || s.listing_key || s.listingKey,
            propertyAddress: s.property_address || s.propertyAddress,
            status: s.status,
            showingDate: s.showing_date || s.showingDate,
            timeWindow: s.time_window_start && s.time_window_end
              ? `${s.time_window_start} - ${s.time_window_end}`
              : null,
            scheduledAt: s.scheduled_at || s.scheduledAt,
            scheduledEndAt: s.scheduled_end_at || s.scheduledEndAt,
            durationMinutes: s.duration_minutes || s.durationMinutes,
            timezone: s.timezone_name || s.timezone,
            listingAgentName: s.listing_agent_name || s.listingAgentName,
            listingAgentEmail: s.listing_agent_email || s.listingAgentEmail,
            listingAgentPhone: s.listing_agent_phone || s.listingAgentPhone,
            notes: s.notes,
            agentResponseNotes: s.agent_response_notes || s.agentResponseNotes,
            createdAt: s.created_at || s.createdAt,
            updatedAt: s.updated_at || s.updatedAt,
            confirmedAt: s.confirmed_at || s.confirmedAt,
            expiresAt: s.expires_at || s.expiresAt,
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

Parameters:
- showingId: The showing UUID to reschedule (REQUIRED)
- newDate: New date - can be "tomorrow", "next week", "next monday", or YYYY-MM-DD format
- newTime: Time in HH:MM format (e.g., "14:00" for 2pm)
- durationMinutes: New duration (default: 30)
- reason: Reason for rescheduling

Examples:
- "reschedule my showing to next Monday at 2pm"
- "change my showing to tomorrow at 10am"
- "move my tour to December 15th at 3pm"`,

  schema: z.object({
    showingId: z.string().describe("Showing ID (UUID) to reschedule"),
    newDate: z
      .string()
      .describe("New date - can be 'tomorrow', 'next week', 'next monday', or YYYY-MM-DD format"),
    newTime: z
      .string()
      .describe("New time in HH:MM format (e.g., '14:00' for 2pm)"),
    durationMinutes: z
      .number()
      .optional()
      .describe("New duration in minutes (default: 30)"),
    reason: z.string().optional().describe("Reason for rescheduling"),
  }),

  func: async ({ showingId, newDate, newTime, durationMinutes, reason }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
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
      // Parse the date
      const isoDate = parseDate(newDate);

      // Build ISO 8601 datetime with timezone
      // Default to America/New_York for South Florida
      const timezone = "America/New_York";
      const scheduledAt = `${isoDate}T${newTime}:00`;

      const requestBody = {
        scheduledAt,
        durationMinutes: durationMinutes || 30,
        timezone,
        reason: reason || undefined,
      };

      console.log("[Showing Reschedule] Request:", requestBody);

      const response = await fetch(
        `${BACKEND_URL}/api/showings/${showingId}/reschedule`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
          },
          body: JSON.stringify(requestBody),
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to reschedule" }))) as any;
        console.error("[Showing Reschedule] Backend error:", error);
        return JSON.stringify(
          {
            success: false,
            error: error.error?.message || error.error || "Failed to reschedule showing",
            details: error.error?.details || undefined,
            message: "Unable to reschedule showing. Please check the parameters.",
          },
          null,
          2,
        );
      }

      const data = (await response.json()) as any;
      const showing = data.data?.showing || data.showing || data;

      return JSON.stringify(
        {
          success: true,
          showingId: showing.id || showingId,
          status: showing.status,
          newDate: isoDate,
          newTime,
          message: "Showing reschedule request submitted successfully. The listing agent will be notified.",
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
    showingId: z.string().describe("Showing ID (UUID) to cancel"),
    reason: z.string().optional().describe("Reason for cancellation"),
  }),

  func: async ({ showingId, reason }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
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
        body: JSON.stringify({ reason: reason || "Cancelled by user via assistant" }),
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
            error: error.error?.message || error.error || "Failed to cancel showing",
            message: "Unable to cancel showing",
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
