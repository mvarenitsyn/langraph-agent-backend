/**
 * Event types for streaming OnStep messages
 */

export type EventType =
  | 'step.start'
  | 'step.end'
  | 'tool.start'
  | 'tool.end'
  | 'reflection.start'
  | 'reflection.end'
  | 'retry.start'
  | 'error'
  | 'final';

export interface StreamEvent {
  type: EventType;
  timestamp: number;
  data: Record<string, any>;
  nodeName?: string;
  stepNumber?: number;
}

export interface StepStartEvent extends StreamEvent {
  type: 'step.start';
  data: {
    nodeName: string;
    stepNumber: number;
    state: Record<string, any>;
  };
}

export interface StepEndEvent extends StreamEvent {
  type: 'step.end';
  data: {
    nodeName: string;
    stepNumber: number;
    duration: number;
    state: Record<string, any>;
  };
}

export interface ToolStartEvent extends StreamEvent {
  type: 'tool.start';
  data: {
    toolName: string;
    input: any;
  };
}

export interface ToolEndEvent extends StreamEvent {
  type: 'tool.end';
  data: {
    toolName: string;
    output: any;
    duration: number;
  };
}

export interface ErrorEvent extends StreamEvent {
  type: 'error';
  data: {
    error: string;
    nodeName?: string;
    retryCount?: number;
  };
}

export interface FinalEvent extends StreamEvent {
  type: 'final';
  data: {
    response: string;
    totalSteps: number;
    totalDuration: number;
  };
}
