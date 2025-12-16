import { AIMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { createResponseModel } from "../models/openai.js";
import { getPlatformContext } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";
import { getSearchResults } from "../subgraphs/property-search/db/search-results.js";
import pg from "pg";

const { Pool } = pg;

// Lazy-initialize database pool
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return pool;
}

/**
 * Similarity result from pgvector query
 */
interface SimilarityResult {
  listingKey: string;
  similarityScore: number;
  roomLabel: string;
  imagePath: string;
  thumbnailUrl: string;
  address: string;
  city: string;
  price: number;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Classify room type from image using Gemini 2.0 Flash
 */
async function classifyRoomType(base64Data: string, mimeType: string): Promise<string> {
  console.log('[ImageSimilarity] Classifying room type with Gemini...');

  const apiKey = process.env.GOOGLE_AI_STUDIO_KEY;
  if (!apiKey) {
    console.warn('[ImageSimilarity] GOOGLE_AI_STUDIO_KEY not set, defaulting to "unknown"');
    return 'unknown';
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data,
                },
              },
              {
                text: `Classify this image into ONE of these room types. Reply with ONLY the room type name, nothing else:
- Kitchen
- Bedroom
- Bathroom
- Living Room
- Dining Room
- Pool
- Exterior
- Patio
- Garage
- Office
- Other

Room type:`,
              },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 20,
          },
        }),
      }
    );

    if (!response.ok) {
      console.error('[ImageSimilarity] Gemini API error:', response.status);
      return 'unknown';
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const roomType = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'unknown';
    console.log('[ImageSimilarity] Detected room type:', roomType);
    return roomType;
  } catch (error) {
    console.error('[ImageSimilarity] Room classification error:', error);
    return 'unknown';
  }
}

/**
 * Generate image embedding using Vertex AI multimodalembedding
 */
async function generateImageEmbedding(base64Data: string): Promise<number[]> {
  console.log('[ImageSimilarity] Generating embedding with Vertex AI...');

  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'rgaautomations';
  const location = 'us-central1';
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error('GOOGLE_ACCESS_TOKEN not set for Vertex AI');
  }

  try {
    const response = await fetch(
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/multimodalembedding@001:predict`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instances: [{
            image: {
              bytesBase64Encoded: base64Data,
            },
          }],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vertex AI error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      predictions?: Array<{ imageEmbedding?: number[] }>;
    };
    const embedding = data.predictions?.[0]?.imageEmbedding;

    if (!embedding || embedding.length !== 1408) {
      throw new Error(`Invalid embedding: expected 1408 dimensions, got ${embedding?.length || 0}`);
    }

    console.log('[ImageSimilarity] Generated 1408-dim embedding');
    return embedding;
  } catch (error) {
    console.error('[ImageSimilarity] Embedding generation error:', error);
    throw error;
  }
}

/**
 * Query property_image_embeddings with pgvector
 */
async function searchSimilarImages(
  embedding: number[],
  roomLabel: string,
  listingKeys: string[],
  cutoff: number = 0.6
): Promise<SimilarityResult[]> {
  console.log(`[ImageSimilarity] Searching for similar ${roomLabel} images among ${listingKeys.length} properties...`);

  const db = getPool();

  // Build embedding vector string for pgvector
  const vectorStr = `[${embedding.join(',')}]`;

  const query = `
    SELECT
      pie.listing_key,
      1 - (pie.embedding <=> $1::vector) as similarity_score,
      pie.room_label,
      pie.image_path,
      CONCAT('https://storage.googleapis.com/myvista-property-photos/properties/',
             pie.listing_key, '/', pie.image_path) as thumbnail_url,
      tp.unparsed_address as address,
      tp.city,
      tp.list_price as price,
      tp.bedrooms_total as bedrooms,
      tp.bathrooms_total_integer as bathrooms,
      tp.living_area as sqft,
      tp.latitude,
      tp.longitude
    FROM property_image_embeddings pie
    LEFT JOIN trestle_properties tp ON pie.listing_key = tp.listing_key
    WHERE pie.room_label ILIKE $2
      AND pie.listing_key = ANY($3)
      AND (1 - (pie.embedding <=> $1::vector)) >= $4
    ORDER BY pie.embedding <=> $1::vector
    LIMIT 50;
  `;

  try {
    const result = await db.query(query, [vectorStr, roomLabel, listingKeys, cutoff]);

    const similarResults: SimilarityResult[] = result.rows.map(row => ({
      listingKey: row.listing_key,
      similarityScore: parseFloat(row.similarity_score),
      roomLabel: row.room_label,
      imagePath: row.image_path,
      thumbnailUrl: row.thumbnail_url,
      address: row.address || 'Unknown',
      city: row.city || '',
      price: row.price || 0,
      bedrooms: row.bedrooms || 0,
      bathrooms: row.bathrooms || 0,
      sqft: row.sqft || 0,
      latitude: row.latitude,
      longitude: row.longitude,
    }));

    console.log(`[ImageSimilarity] Found ${similarResults.length} similar properties (cutoff: ${cutoff})`);
    return similarResults;
  } catch (error) {
    console.error('[ImageSimilarity] pgvector query error:', error);
    throw error;
  }
}

/**
 * Image Similarity Search Node
 *
 * Two-step visual similarity search:
 * 1. Get listing_keys from prior property search (via searchId)
 * 2. Classify room type from user's image (Gemini 2.0 Flash)
 * 3. Generate embedding from user's image (Vertex AI)
 * 4. Query pgvector for similar room images within search results
 * 5. Publish similarity_results UI event
 */
export async function imageSimilaritySearchNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[ImageSimilarity] ====== Image Similarity Search Node ======');

  // Validate image attachment
  if (!state.imageAttachment) {
    console.error('[ImageSimilarity] No image attachment found');
    return {
      error: 'No image attachment provided for similarity search',
      finalResponse: 'Please attach an image to search for similar properties.',
    };
  }

  const { base64Data, mimeType, sizeBytes } = state.imageAttachment;

  // Validate size (10MB max)
  if (sizeBytes > 10 * 1024 * 1024) {
    return {
      error: 'Image too large (max 10MB)',
      finalResponse: 'The image is too large. Please use an image under 10MB.',
    };
  }

  console.log(`[ImageSimilarity] Processing image: ${mimeType}, ${(sizeBytes / 1024).toFixed(1)}KB`);

  // Get searchId from prior property search task
  const searchId = state.metadata?.searchId || state.taskList?.tasks.find(t =>
    t.route === 'PROPERTY_SEARCH' && t.result?.searchId
  )?.result?.searchId;

  if (!searchId) {
    console.warn('[ImageSimilarity] No searchId found - searching all properties');
  }

  try {
    // Emit progress: Analyzing image
    await sharedPublisher.publishProgressUpdate({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      status: 'Analyzing image...',
    });

    // Step 1: Get listing keys from search results
    let listingKeys: string[] = [];
    if (searchId) {
      console.log(`[ImageSimilarity] Fetching listing keys from searchId: ${searchId}`);
      const searchResults = await getSearchResults({ searchId, pageSize: 1000 }); // Get up to 1000 properties
      listingKeys = searchResults.results.map((p) => p.listingKey);
      console.log(`[ImageSimilarity] Got ${listingKeys.length} listing keys from search`);
    }

    // Step 2: Classify room type with Gemini
    // Note: If GOOGLE_AI_STUDIO_KEY not set, classify based on user message
    let roomLabel = await classifyRoomType(base64Data, mimeType);

    // Fallback: Extract room type from user message if Gemini fails
    if (roomLabel === 'unknown') {
      const message = state.message?.toLowerCase() || '';
      if (message.includes('kitchen')) roomLabel = 'Kitchen';
      else if (message.includes('bedroom')) roomLabel = 'Bedroom';
      else if (message.includes('bathroom')) roomLabel = 'Bathroom';
      else if (message.includes('living')) roomLabel = 'Living Room';
      else if (message.includes('pool')) roomLabel = 'Pool';
      else if (message.includes('exterior') || message.includes('outside')) roomLabel = 'Exterior';
      console.log(`[ImageSimilarity] Fallback room detection from message: ${roomLabel}`);
    }

    // Emit progress: Finding similar rooms
    await sharedPublisher.publishProgressUpdate({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      status: `Finding similar ${roomLabel.toLowerCase()}s...`,
    });

    // Step 3: Generate embedding with Vertex AI
    const embedding = await generateImageEmbedding(base64Data);

    // Step 4: Query pgvector for similar images
    // Note: Lower cutoff (0.3) to show more results - users can filter by score
    const similarityResults = await searchSimilarImages(
      embedding,
      roomLabel,
      listingKeys.length > 0 ? listingKeys : [], // Empty array means search all
      0.3 // Similarity cutoff (lowered from 0.6 to show more results)
    );

    // Step 5: Publish UI event with results
    await uiEventPublisher.publishUIEvent({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      renderType: 'similarity_results',
      data: {
        results: similarityResults,
        roomLabel,
        totalCount: similarityResults.length,
        searchId,
      },
    });

    console.log(`[ImageSimilarity] ✓ Published ${similarityResults.length} similarity results`);

    // Generate response text
    const platformContext = getPlatformContext(state);
    const userContext = state.userContext || { isAuthenticated: false };
    const firstName = userContext.fullName?.split(' ')[0] || 'there';

    const responseModel = createResponseModel();
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);

    const responseMessages = [
      {
        role: 'system' as const,
        content: `You are RealVista, helping ${firstName} find properties with similar ${roomLabel.toLowerCase()}s.

Generate a brief, helpful response about the similarity search results.

${platformFormattingInstructions}`,
      },
      {
        role: 'user' as const,
        content: `The user attached a ${roomLabel.toLowerCase()} photo and asked: "${state.message}"

Search results:
- Room type detected: ${roomLabel}
- Properties searched: ${listingKeys.length || 'all'}
- Similar matches found: ${similarityResults.length}
${similarityResults.length > 0 ? `- Top match: ${similarityResults[0].address} (${(similarityResults[0].similarityScore * 100).toFixed(0)}% similar)` : ''}

Generate a concise response.`,
      },
    ];

    const response = await responseModel.invoke(responseMessages);
    let finalResponse = response.content as string;

    // Adapt for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
    }

    return {
      finalResponse,
      messages: [new AIMessage({ content: finalResponse })],
      toolResults: {
        imageSimilarity: {
          roomLabel,
          totalCount: similarityResults.length,
          results: similarityResults.slice(0, 10), // Keep top 10 in state
        },
      },
      platformContext,
    };
  } catch (error) {
    console.error('[ImageSimilarity] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Image similarity search failed',
      finalResponse: 'I encountered an error searching for similar properties. Please try again.',
    };
  }
}
