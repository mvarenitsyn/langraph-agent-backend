/**
 * Collections Tools
 *
 * Manage user property collections via backend API.
 * Allows creating, listing, updating, and sharing property collections.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

const BACKEND_URL = process.env.BACKEND_URL || "https://localhost:3001";

// Skip SSL verification for local development
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Collection Create Tool
 *
 * Create a new property collection for the user.
 */
export const collectionCreateTool = new DynamicStructuredTool({
  name: "collection_create",
  description: `Create a new property collection.

⚠️ PREREQUISITE: The user must be authenticated (have a userId).

Use this when the user wants to:
- Create a new collection
- Save properties to a new list
- Organize properties

Examples:
- "create a collection called Favorites"
- "make a new collection for Miami properties"
- "save these properties to a new list"`,

  schema: z.object({
    title: z.string().describe("Collection title/name"),
    description: z
      .string()
      .optional()
      .describe("Optional collection description"),
    properties: z
      .array(z.string())
      .optional()
      .describe("Optional array of listingKeys to add initially"),
  }),

  func: async ({ title, description, properties }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event
      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",
          feature: "collections",
          message: "Please log in to create and manage property collections.",
          sessionId,
          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,
          error: "Authentication required",
          message: "Please log in to create collections.",
          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/user-collections`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          title,
          description,
          properties: properties || [],
        }),
        // @ts-ignore
        agent: httpsAgent,
      });

      if (!response.ok) {
        const error = (await response
          .json()
          .catch(() => ({ error: "Failed to create collection" }))) as any;
        return JSON.stringify(
          {
            success: false,
            error: error.error || "Failed to create collection",
            message: error.message || "Unable to create collection",
          },
          null,
          2,
        );
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          collectionId: data.id,
          title: data.title,
          description: data.description,
          propertiesCount: data.properties?.length || 0,
          message: `Collection "${title}" created successfully`,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Collection Create] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to create collection. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Collection List Tool
 *
 * List user's saved collections.
 */
export const collectionListTool = new DynamicStructuredTool({
  name: "collection_list",
  description: `List user's saved property collections.

Use this when the user wants to:
- See their saved collections
- Browse their collections
- Find a specific collection

Examples:
- "show my collections"
- "what collections do I have?"
- "list my saved properties"`,

  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe("Maximum number of collections to return (default: 20)"),
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
          feature: "collections",
          message: "Please log in to view your property collections.",
          sessionId,
          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,
          error: "Authentication required",
          message: "Please log in to view collections.",
          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const params = new URLSearchParams();
      if (limit) params.append("limit", limit.toString());
      if (offset) params.append("offset", offset.toString());

      const response = await fetch(
        `${BACKEND_URL}/api/user-collections?${params}`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch collections: ${response.status}`);
      }

      const data = (await response.json()) as any;
      const collections = data.collections || [];

      return JSON.stringify(
        {
          success: true,
          collections: collections.map((c: any) => ({
            id: c.id,
            title: c.title,
            description: c.description,
            propertiesCount: c.properties_count || c.propertiesCount || 0,
            createdAt: c.created_at || c.createdAt,
            updatedAt: c.updated_at || c.updatedAt,
          })),
          totalCount: data.total || collections.length,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Collection List] Error:", error);
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
 * Collection Get Tool
 *
 * Get collection details with properties.
 */
export const collectionGetTool = new DynamicStructuredTool({
  name: "collection_get",
  description: `Get collection details including all properties.

Use this when the user wants to:
- View a specific collection
- See properties in a collection
- Get collection details

Examples:
- "show me my Favorites collection"
- "what's in my Miami collection?"
- "view collection details"`,

  schema: z.object({
    collectionId: z.string().describe("Collection ID"),
  }),

  func: async ({ collectionId }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event
      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",
          feature: "collections",
          message: "Please log in to view collection details.",
          sessionId,
          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,
          error: "Authentication required",
          message: "Please log in to view collections.",
          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/user-collections/${collectionId}`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          return JSON.stringify(
            {
              success: false,
              error: "Collection not found",
              message: "Collection does not exist or you do not have access.",
            },
            null,
            2,
          );
        }
        throw new Error(`Failed to fetch collection: ${response.status}`);
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          collection: {
            id: data.id,
            title: data.title,
            description: data.description,
            properties: data.properties || [],
            propertiesCount: data.properties?.length || 0,
            createdAt: data.created_at || data.createdAt,
            updatedAt: data.updated_at || data.updatedAt,
          },
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Collection Get] Error:", error);
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
 * Collection Add Property Tool
 *
 * Add a property to an existing collection.
 */
export const collectionAddPropertyTool = new DynamicStructuredTool({
  name: "collection_add_property",
  description: `Add a property to an existing collection.

Use this when the user wants to:
- Add a property to a collection
- Save a property to their favorites
- Add to an existing list

Examples:
- "add this property to my Favorites"
- "save this to my Miami collection"
- "add this listing to my collection"`,

  schema: z.object({
    collectionId: z.string().describe("Collection ID to add to"),
    listingKey: z.string().describe("Property ListingKey to add"),
  }),

  func: async ({ collectionId, listingKey }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event
      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",
          feature: "collections",
          message: "Please log in to add properties to collections.",
          sessionId,
          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,
          error: "Authentication required",
          message: "Please log in to modify collections.",
          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      // First, get current collection to add property
      const getResponse = await fetch(
        `${BACKEND_URL}/api/user-collections/${collectionId}`,
        {
          headers: { "x-user-id": userId },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!getResponse.ok) {
        throw new Error("Collection not found");
      }

      const currentCollection = (await getResponse.json()) as any;
      const currentProperties = currentCollection.properties || [];

      // Check if property already exists
      if (
        currentProperties.some(
          (p: any) =>
            p.listingKey === listingKey || p.listing_key === listingKey,
        )
      ) {
        return JSON.stringify(
          {
            success: false,
            error: "Property already in collection",
            message: "This property is already saved to this collection.",
          },
          null,
          2,
        );
      }

      // Add new property
      const updatedProperties = [...currentProperties, { listingKey }];

      const updateResponse = await fetch(
        `${BACKEND_URL}/api/user-collections/${collectionId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
          },
          body: JSON.stringify({
            title: currentCollection.title,
            description: currentCollection.description,
            properties: updatedProperties,
          }),
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!updateResponse.ok) {
        throw new Error("Failed to update collection");
      }

      const updated = (await updateResponse.json()) as any;

      return JSON.stringify(
        {
          success: true,
          collectionId: updated.id,
          collectionTitle: updated.title,
          propertiesCount:
            updated.properties?.length || updatedProperties.length,
          message: `Property added to "${updated.title}"`,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Collection Add Property] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to add property to collection. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Collection Share Tool
 *
 * Share a collection and get a shareable link.
 */
export const collectionShareTool = new DynamicStructuredTool({
  name: "collection_share",
  description: `Share a collection and generate a shareable link.

Use this when the user wants to:
- Share a collection with others
- Get a shareable link
- Make a collection public

Examples:
- "share my Favorites collection"
- "get a link for my Miami collection"
- "make this collection shareable"`,

  schema: z.object({
    collectionId: z.string().describe("Collection ID to share"),
  }),

  func: async ({ collectionId }, config) => {
    const userId = (config as any)?.metadata?.userId;
    const sessionId = (config as any)?.metadata?.sessionId;
    const correlationId = (config as any)?.metadata?.correlationId;

    if (!userId) {
      // Publish login required UI event
      if (sessionId && correlationId) {
        await uiEventPublisher.publishLoginRequired({
          reason: "Authentication required",
          feature: "collections",
          message: "Please log in to share collections.",
          sessionId,
          correlationId,
        });
      }

      return JSON.stringify(
        {
          success: false,
          error: "Authentication required",
          message: "Please log in to share collections.",
          requiresAuth: true,
        },
        null,
        2,
      );
    }

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/user-collections/${collectionId}/share`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
          },
          // @ts-ignore
          agent: httpsAgent,
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          return JSON.stringify(
            {
              success: false,
              error: "Collection not found",
              message: "Collection does not exist or you do not have access.",
            },
            null,
            2,
          );
        }
        throw new Error(`Failed to share collection: ${response.status}`);
      }

      const data = (await response.json()) as any;

      return JSON.stringify(
        {
          success: true,
          shareUrl: data.shareUrl || data.share_url,
          shareId: data.shareId || data.share_id,
          message: "Collection shared successfully",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[Collection Share] Error:", error);
      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to share collection. Please try again.",
        },
        null,
        2,
      );
    }
  },
});

// Export all tools as array
export const collectionTools = [
  collectionCreateTool,
  collectionListTool,
  collectionGetTool,
  collectionAddPropertyTool,
  collectionShareTool,
];
