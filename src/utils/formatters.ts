/**
 * Platform-Specific Response Formatters
 *
 * Utilities for formatting agent responses according to
 * platform-specific rules and constraints.
 */

import { PlatformContext } from '../types/platform.js';

/**
 * Format a property listing for the given platform
 */
export function formatPropertyListing(
  property: {
    address: string;
    price: number;
    beds: number;
    baths: number;
    sqft?: number;
    listingId: string;
  },
  platformContext: PlatformContext
): string {
  const { formatting } = platformContext;
  const priceFormatted = `$${property.price.toLocaleString()}`;

  if (platformContext.platform === 'whatsapp') {
    // WhatsApp-optimized format (compact, plain URLs)
    return [
      `${formatting.boldSyntax}${property.address}${formatting.boldSyntax}`,
      `${priceFormatted} • ${property.beds} bed, ${property.baths} bath${property.sqft ? ` • ${property.sqft.toLocaleString()} sqft` : ''}`,
      `Listing: ${property.listingId}`,
    ].join('\n');
  }

  // Web format (richer formatting)
  return [
    `${formatting.boldSyntax}${property.address}${formatting.boldSyntax}`,
    `${formatting.bulletStyle} Price: ${priceFormatted}`,
    `${formatting.bulletStyle} Beds/Baths: ${property.beds}/${property.baths}`,
    property.sqft ? `${formatting.bulletStyle} Size: ${property.sqft.toLocaleString()} sqft` : '',
    `${formatting.bulletStyle} Listing: ${property.listingId}`,
  ].filter(Boolean).join('\n');
}

/**
 * Format a link based on platform capabilities
 */
export function formatLink(
  url: string,
  text: string,
  platformContext: PlatformContext
): string {
  if (platformContext.formatting.linkFormat === 'markdown') {
    return `[${text}](${url})`;
  }
  // Plain format for WhatsApp
  return url;
}

/**
 * Truncate response to platform's max length
 */
export function truncateResponse(
  response: string,
  platformContext: PlatformContext,
  suffix: string = '...'
): string {
  const maxLen = platformContext.capabilities.maxMessageLength;

  if (response.length <= maxLen) {
    return response;
  }

  // Find a good break point
  const cutoff = maxLen - suffix.length;
  const lastNewline = response.lastIndexOf('\n', cutoff);
  const lastSpace = response.lastIndexOf(' ', cutoff);

  const breakPoint = lastNewline > cutoff * 0.7
    ? lastNewline
    : lastSpace > cutoff * 0.7
      ? lastSpace
      : cutoff;

  return response.substring(0, breakPoint).trim() + suffix;
}

/**
 * Convert generic markdown to platform-specific formatting
 */
export function adaptMarkdown(
  text: string,
  platformContext: PlatformContext
): string {
  if (platformContext.platform === 'web') {
    return text; // Web supports standard markdown
  }

  // WhatsApp adaptations
  let adapted = text;

  // Convert **bold** to *bold* (WhatsApp uses single asterisks)
  adapted = adapted.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Convert [text](url) to plain url (WhatsApp doesn't support markdown links)
  adapted = adapted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');

  // Convert * bullets to - bullets (at start of line)
  adapted = adapted.replace(/^\* /gm, '- ');

  // Remove nested indentation (WhatsApp doesn't support it)
  adapted = adapted.replace(/^(\s{2,})[*-] /gm, '- ');

  // Remove triple backticks code blocks (simplify for WhatsApp)
  adapted = adapted.replace(/```[\s\S]*?```/g, (match) => {
    // Extract content without backticks
    const content = match.replace(/```\w*\n?/g, '').replace(/```/g, '').trim();
    return content;
  });

  // Convert inline code `code` to plain text
  adapted = adapted.replace(/`([^`]+)`/g, '$1');

  return adapted;
}

/**
 * Build platform-specific formatting instructions for prompts
 */
export function buildFormattingInstructions(
  platformContext: PlatformContext
): string {
  if (platformContext.platform === 'whatsapp') {
    return `
**WHATSAPP FORMATTING RULES (CRITICAL):**
1. Keep responses under ${platformContext.capabilities.maxMessageLength} characters
2. Bold: Use single asterisks: *text*
3. Italic: Use underscores: _text_
4. Bullets: Use hyphen at START of line (no indentation): - text
5. NO NESTED/INDENTED LISTS - WhatsApp doesn't support them
6. Links: Use plain URLs only (no markdown links like [text](url))
7. For property details, use compact format with bullet separator (•)
8. NO code blocks or backticks

**PROPERTY LIST FORMAT (WhatsApp-friendly):**
1. *Address*
   Price • Beds/Baths • Sqft
   Listing: ID
`;
  }

  // Web formatting (standard markdown)
  return `
**FORMATTING:**
- Use standard markdown formatting
- Support rich formatting: **bold**, *italic*, bullet lists
- Links: Use markdown format [text](url)
- Property details can use bullet points and structured layout
- Code blocks with triple backticks are supported
`;
}

/**
 * Format search results summary for the platform
 */
export function formatSearchSummary(
  totalCount: number,
  searchToken: string,
  platformContext: PlatformContext
): string {
  const baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || 'https://realvista.com/search';
  const searchUrl = `${baseUrl}/${searchToken}`;

  if (platformContext.platform === 'whatsapp') {
    return `Found *${totalCount}* properties\n\nView results: ${searchUrl}`;
  }

  return `Found **${totalCount}** properties\n\n[View all results](${searchUrl})`;
}

/**
 * Format an error message for the platform
 */
export function formatErrorMessage(
  error: string,
  platformContext: PlatformContext
): string {
  if (platformContext.platform === 'whatsapp') {
    return `_Error: ${error}_\n\nPlease try again or rephrase your request.`;
  }

  return `*Error:* ${error}\n\nPlease try again or rephrase your request.`;
}
