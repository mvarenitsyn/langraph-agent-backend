/**
 * UI Render Events
 *
 * Events published to the ui.render Pub/Sub topic to trigger
 * UI rendering on the frontend.
 */

/**
 * Generic UI render event structure
 */
export interface UIRenderEvent {
  id: string;
  type: 'ui.render';
  timestamp: string;
  source: 'agent';
  sessionId: string;
  userId?: string;
  correlationId: string;
  payload: {
    renderType: string;
    data: Record<string, any>;
  };
}

/**
 * Payload for search results rendering
 */
export interface SearchResultsPayload {
  searchId: string;
  totalCount: number;
  searchToken?: string;
  mapLink?: string;
}

/**
 * Parameters for publishing UI events
 */
export interface PublishUIEventParams {
  renderType: string;
  data: Record<string, any>;
  sessionId: string;
  userId?: string;
  correlationId: string;
}

/**
 * Parameters for publishing search results
 */
export interface PublishSearchResultsParams {
  searchId: string;
  totalCount: number;
  searchToken?: string;
  mapLink?: string;
  sessionId: string;
  userId?: string;
  correlationId: string;
}

/**
 * Payload for property details rendering
 */
export interface PropertyDetailsPayload {
  searchId: string;
  listingKey: string;
  property?: any; // Optional: include full property data to avoid extra fetch
}

/**
 * Parameters for publishing property details
 */
export interface PublishPropertyDetailsParams {
  searchId: string;
  listingKey: string;
  property?: any;
  sessionId: string;
  userId?: string;
  correlationId: string;
}

/**
 * Payload for login required rendering
 */
export interface LoginRequiredPayload {
  reason: string;
  feature: string;
  message?: string;
}

/**
 * Parameters for publishing login required events
 */
export interface PublishLoginRequiredParams {
  reason: string;
  feature: string;
  message?: string;
  sessionId: string;
  correlationId: string;
}
