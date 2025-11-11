import { StreamEvent } from "../types/events.js";

/**
 * Streaming Utilities
 *
 * Helper functions for creating and sending streaming events
 */

/**
 * Create a formatted SSE (Server-Sent Events) message
 */
export function createSSEMessage(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Create a step start event
 */
export function createStepStartEvent(
  nodeName: string,
  stepNumber: number,
  state: Record<string, any>
): StreamEvent {
  return {
    type: 'step.start',
    timestamp: Date.now(),
    nodeName,
    stepNumber,
    data: {
      nodeName,
      stepNumber,
      state,
    },
  };
}

/**
 * Create a step end event
 */
export function createStepEndEvent(
  nodeName: string,
  stepNumber: number,
  duration: number,
  state: Record<string, any>
): StreamEvent {
  return {
    type: 'step.end',
    timestamp: Date.now(),
    nodeName,
    stepNumber,
    data: {
      nodeName,
      stepNumber,
      duration,
      state,
    },
  };
}

/**
 * Create a tool start event
 */
export function createToolStartEvent(toolName: string, input: any): StreamEvent {
  return {
    type: 'tool.start',
    timestamp: Date.now(),
    data: {
      toolName,
      input,
    },
  };
}

/**
 * Create a tool end event
 */
export function createToolEndEvent(
  toolName: string,
  output: any,
  duration: number
): StreamEvent {
  return {
    type: 'tool.end',
    timestamp: Date.now(),
    data: {
      toolName,
      output,
      duration,
    },
  };
}

/**
 * Create an error event
 */
export function createErrorEvent(
  error: string,
  nodeName?: string,
  retryCount?: number
): StreamEvent {
  return {
    type: 'error',
    timestamp: Date.now(),
    nodeName,
    data: {
      error,
      nodeName,
      retryCount,
    },
  };
}

/**
 * Create a final event
 */
export function createFinalEvent(
  response: string,
  totalSteps: number,
  totalDuration: number
): StreamEvent {
  return {
    type: 'final',
    timestamp: Date.now(),
    data: {
      response,
      totalSteps,
      totalDuration,
    },
  };
}
