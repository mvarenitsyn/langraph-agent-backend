/**
 * Platform Context Resolver
 *
 * Resolves platform context from request metadata and provides
 * utilities for platform-aware operations.
 */

import {
  PlatformType,
  PlatformContext,
  PLATFORM_CONFIGS,
  DEFAULT_PLATFORM_CONTEXT,
} from '../types/platform.js';

/**
 * Resolve platform context from metadata
 *
 * @param metadata - Request metadata containing platform identifier
 * @returns Complete PlatformContext for the detected platform
 */
export function resolvePlatformContext(
  metadata?: Record<string, any>
): PlatformContext {
  // Extract platform from metadata, default to 'web'
  const platformRaw = metadata?.platform as string | undefined;
  const platform: PlatformType =
    platformRaw === 'whatsapp' ? 'whatsapp' : 'web';

  const config = PLATFORM_CONFIGS[platform];

  return {
    platform,
    ...config,
  };
}

/**
 * Check if a tool is enabled for the given platform
 *
 * @param toolName - Name of the tool to check
 * @param platformContext - Platform context
 * @returns true if tool is enabled
 */
export function isToolEnabledForPlatform(
  toolName: string,
  platformContext: PlatformContext
): boolean {
  // If explicitly disabled, return false
  if (platformContext.toolConfig.disabledTools.includes(toolName)) {
    return false;
  }

  // If enabledTools is empty, all tools are enabled (default behavior)
  if (platformContext.toolConfig.enabledTools.length === 0) {
    return true;
  }

  // Otherwise, check if it's in the enabled list
  return platformContext.toolConfig.enabledTools.includes(toolName);
}

/**
 * Filter tools based on platform context
 *
 * @param tools - Array of tools to filter
 * @param platformContext - Platform context
 * @returns Filtered array of tools enabled for the platform
 */
export function filterToolsForPlatform<T extends { name: string }>(
  tools: T[],
  platformContext: PlatformContext
): T[] {
  return tools.filter((tool) =>
    isToolEnabledForPlatform(tool.name, platformContext)
  );
}

/**
 * Check if UI events should be published for the platform
 *
 * @param platformContext - Platform context
 * @returns true if UI events should be published
 */
export function shouldPublishUIEvents(
  platformContext: PlatformContext
): boolean {
  return platformContext.capabilities.supportsRichUI;
}

/**
 * Check if platform supports streaming responses
 *
 * @param platformContext - Platform context
 * @returns true if streaming is supported
 */
export function supportsStreaming(
  platformContext: PlatformContext
): boolean {
  return platformContext.capabilities.supportsStreaming;
}

/**
 * Get the platform from state or metadata, with fallback to default
 *
 * @param state - Agent state that may contain platformContext
 * @returns Platform context (resolved or default)
 */
export function getPlatformContext(
  state: { platformContext?: PlatformContext; metadata?: Record<string, any> }
): PlatformContext {
  // If platformContext is already set in state, use it
  if (state.platformContext?.platform) {
    return state.platformContext;
  }

  // Otherwise, resolve from metadata
  return resolvePlatformContext(state.metadata);
}
