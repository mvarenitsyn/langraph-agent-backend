/**
 * Platform Context Types
 *
 * Defines platform-specific capabilities and formatting rules
 * for Web and WhatsApp platforms.
 */

export type PlatformType = 'web' | 'whatsapp';

/**
 * Platform Capabilities
 * Defines what features each platform supports
 */
export interface PlatformCapabilities {
  /** Whether the platform supports rich UI components (maps, modals, cards) */
  supportsRichUI: boolean;
  /** Whether the platform supports markdown links [text](url) */
  supportsMarkdownLinks: boolean;
  /** Whether the platform supports nested lists */
  supportsNestedLists: boolean;
  /** Maximum message length (characters) */
  maxMessageLength: number;
  /** Whether the platform supports streaming responses */
  supportsStreaming: boolean;
}

/**
 * Platform Formatting Rules
 * Defines how to format text for each platform
 */
export interface PlatformFormattingRules {
  /** Style for bullet points: '*' for web, '-' for WhatsApp */
  bulletStyle: '*' | '-';
  /** Bold syntax: '**' for web markdown, '*' for WhatsApp */
  boldSyntax: '**' | '*';
  /** Italic syntax: '*' for web markdown, '_' for WhatsApp */
  italicSyntax: '*' | '_';
  /** How to format links */
  linkFormat: 'markdown' | 'plain';
}

/**
 * Tool Availability Configuration
 * Which tools are available for each platform
 */
export interface PlatformToolConfig {
  /** Tools that are enabled for this platform */
  enabledTools: string[];
  /** Tools that are disabled for this platform */
  disabledTools: string[];
}

/**
 * Complete Platform Context
 */
export interface PlatformContext {
  platform: PlatformType;
  capabilities: PlatformCapabilities;
  formatting: PlatformFormattingRules;
  toolConfig: PlatformToolConfig;
}

/**
 * Default Platform Configurations
 */
export const PLATFORM_CONFIGS: Record<PlatformType, Omit<PlatformContext, 'platform'>> = {
  web: {
    capabilities: {
      supportsRichUI: true,
      supportsMarkdownLinks: true,
      supportsNestedLists: true,
      maxMessageLength: 10000,
      supportsStreaming: true,
    },
    formatting: {
      bulletStyle: '*',
      boldSyntax: '**',
      italicSyntax: '*',
      linkFormat: 'markdown',
    },
    toolConfig: {
      enabledTools: [
        'property_search',
        'property_filter_sort',
        'property_get_results',
        'property_get_details',
        'cma_generate',
        'cma_history',
        'property_discover_fields',
        'property_analyze',
        'property_query',
        'perplexity_search',
        'address_validator',
      ],
      disabledTools: [],
    },
  },
  whatsapp: {
    capabilities: {
      supportsRichUI: false,
      supportsMarkdownLinks: false,
      supportsNestedLists: false,
      maxMessageLength: 1200,
      supportsStreaming: false,
    },
    formatting: {
      bulletStyle: '-',
      boldSyntax: '*',
      italicSyntax: '_',
      linkFormat: 'plain',
    },
    toolConfig: {
      enabledTools: [
        'property_search',
        'property_filter_sort',
        'property_get_results',
        'property_get_details',
        'cma_generate',
        'cma_history',
        'perplexity_search',
        'address_validator',
      ],
      // Disable UI-centric tools for WhatsApp
      disabledTools: [
        'property_discover_fields', // Produces complex tabular output
        'property_analyze',         // Produces complex analysis output
        'property_query',           // Complex query results
      ],
    },
  },
};

/**
 * Default platform context (web)
 */
export const DEFAULT_PLATFORM_CONTEXT: PlatformContext = {
  platform: 'web',
  ...PLATFORM_CONFIGS.web,
};
