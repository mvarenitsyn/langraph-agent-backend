import { PubSub } from '@google-cloud/pubsub';
import { v4 as uuidv4 } from 'uuid';
import {
  UIRenderEvent,
  PublishUIEventParams,
  PublishSearchResultsParams,
  PublishPropertyDetailsParams,
} from '../types/ui-events';
import { config } from '../config/index.js';

/**
 * UI Event Publisher
 *
 * Publishes UI render events to the ui.render Pub/Sub topic
 * to trigger frontend rendering of search results, property details, etc.
 */
export class UIEventPublisher {
  private pubsub: PubSub;
  private topicName: string;

  constructor() {
    this.pubsub = new PubSub({
      projectId: config.pubsub?.projectId || process.env.GCP_PROJECT_ID,
    });
    this.topicName = config.pubsub?.uiRenderTopic || 'ui.render';
  }

  /**
   * Unified method to publish UI render events
   *
   * @param params - Event parameters
   */
  async publishUIEvent(params: PublishUIEventParams): Promise<void> {
    try {
      const event: UIRenderEvent = {
        id: uuidv4(),
        type: 'ui.render',
        timestamp: new Date().toISOString(),
        source: 'agent',
        sessionId: params.sessionId,
        userId: params.userId,
        correlationId: params.correlationId,
        payload: {
          renderType: params.renderType,
          data: params.data,
        },
      };

      const topic = this.pubsub.topic(this.topicName);
      const messageId = await topic.publishMessage({ json: event });

      console.log(
        `[UIEventPublisher] Published ${params.renderType} (msgId: ${messageId}, session: ${params.sessionId})`
      );
    } catch (error) {
      console.error(
        `[UIEventPublisher] Failed to publish ${params.renderType}:`,
        error
      );
      // Don't throw - UI events should not break main execution
    }
  }

  /**
   * Convenience method for publishing search results
   *
   * @param params - Search results parameters
   */
  async publishSearchResults(
    params: PublishSearchResultsParams
  ): Promise<void> {
    await this.publishUIEvent({
      renderType: 'search_results',
      data: {
        searchId: params.searchId,
        totalCount: params.totalCount,
        searchToken: params.searchToken,
        mapLink: params.mapLink,
      },
      sessionId: params.sessionId,
      userId: params.userId,
      correlationId: params.correlationId,
    });
  }

  /**
   * Convenience method for publishing property details
   *
   * @param params - Property details parameters
   */
  async publishPropertyDetails(
    params: PublishPropertyDetailsParams
  ): Promise<void> {
    await this.publishUIEvent({
      renderType: 'property_details',
      data: {
        searchId: params.searchId,
        listingKey: params.listingKey,
        property: params.property,
      },
      sessionId: params.sessionId,
      userId: params.userId,
      correlationId: params.correlationId,
    });
  }
}

// Singleton instance
export const uiEventPublisher = new UIEventPublisher();
