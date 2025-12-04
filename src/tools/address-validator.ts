import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";

/**
 * Address Validator Tool
 *
 * Validates addresses using Google Address Validation API through the backend.
 * Checks if an address exists and provides standardized format with geocode.
 */

// API Response interface
interface AddressValidationResponse {
  success: boolean;
  isValid: boolean;
  formattedAddress?: string;
  addressComponents?: {
    streetNumber?: string;
    route?: string;
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    country?: string;
  };
  geocode?: {
    latitude: number;
    longitude: number;
  };
  metadata?: {
    confidence?: string;
    granularity?: string;
    hasUnconfirmedComponents?: boolean;
    hasInferredComponents?: boolean;
  };
  error?: string;
}

/**
 * Build human-readable summary from validation result
 */
function buildValidationSummary(
  response: AddressValidationResponse,
  originalAddress: string,
): string {
  if (!response.success) {
    return `Address validation failed: ${response.error || "Unknown error"}. The service may be unavailable.`;
  }

  if (!response.isValid) {
    const parts: string[] = [];
    parts.push(`⚠️  Address may not be valid: "${originalAddress}"`);

    if (response.formattedAddress) {
      parts.push(`\nClosest match: "${response.formattedAddress}"`);
    }

    if (response.metadata?.hasUnconfirmedComponents) {
      parts.push(`\nNote: Some address components could not be confirmed.`);
    }

    if (response.metadata?.hasInferredComponents) {
      parts.push(`\nNote: Some address components were inferred.`);
    }

    parts.push(
      `\nSuggestion: Please verify the address or try a more specific format.`,
    );

    return parts.join("");
  }

  // Valid address
  const parts: string[] = [];
  parts.push(
    `✓ Valid address confirmed: "${response.formattedAddress || originalAddress}"`,
  );

  if (response.geocode) {
    parts.push(
      `\nLocation: ${response.geocode.latitude.toFixed(6)}, ${response.geocode.longitude.toFixed(6)}`,
    );
  }

  if (response.metadata?.confidence) {
    const confidenceLevel = response.metadata.confidence;
    if (confidenceLevel === "ROOFTOP" || confidenceLevel === "PREMISE") {
      parts.push(`\nConfidence: High (precise location)`);
    } else if (confidenceLevel === "RANGE_INTERPOLATED") {
      parts.push(`\nConfidence: Medium (approximate location)`);
    } else {
      parts.push(`\nConfidence: ${confidenceLevel}`);
    }
  }

  if (response.addressComponents) {
    const components = response.addressComponents;
    const addressLine = [components.streetNumber, components.route]
      .filter(Boolean)
      .join(" ");

    const cityStateZip = [
      components.locality,
      components.administrativeArea,
      components.postalCode,
    ]
      .filter(Boolean)
      .join(", ");

    if (addressLine || cityStateZip) {
      parts.push(
        `\nComponents: ${addressLine || ""} ${cityStateZip || ""}`.trim(),
      );
    }
  }

  return parts.join("");
}

/**
 * Address Validator Tool
 */
export const addressValidatorTool = new DynamicStructuredTool({
  name: "validate_address",
  description: `Validate whether an address exists and get its standardized format with geocoding.

This tool uses Google Address Validation API to:
- Check if an address is valid and exists
- Provide standardized, formatted address
- Return precise geocoding (latitude/longitude)
- Identify any unconfirmed or inferred components

Use this tool when:
- User asks if an address exists or is valid
- You need to verify an address before searching for properties
- You need standardized address format for accurate property search
- User provides an address that might have typos or formatting issues

Examples:
- "Is 1000 W Island Blvd Apt 2309, Aventura, FL 33160 a valid address?"
- "Validate this address: 123 Main St, Miami, FL"
- "Does this address exist: 456 Ocean Drive, Miami Beach"

The tool returns validation status, formatted address, and geocode coordinates.`,
  schema: z.object({
    address: z
      .string()
      .describe(
        "Full address string to validate (e.g., '1000 W Island Blvd Apt 2309, Aventura, FL 33160')",
      ),
  }),
  func: async ({ address }, config) => {
    console.log(`[AddressValidatorTool] Validating: "${address}"`);

    try {
      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      console.log("[AddressValidatorTool] Making API request to backend...");

      // Make API request to backend
      const response = await fetch(
        "https://localhost:3001/api/validate-address",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            address,
          }),
          // @ts-ignore - Node.js fetch supports agent option
          agent: httpsAgent,
        },
      );

      console.log("[AddressValidatorTool] Response status:", response.status);

      if (!response.ok) {
        console.error("[AddressValidatorTool] API error - status not ok");
        throw new Error(
          `API returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as AddressValidationResponse;
      console.log(
        "[AddressValidatorTool] Response data:",
        JSON.stringify(data, null, 2),
      );

      // Build summary for LLM
      const summary = buildValidationSummary(data, address);

      // Return structured data
      return JSON.stringify(
        {
          success: data.success,
          isValid: data.isValid,
          summary,
          formattedAddress: data.formattedAddress || null,
          geocode: data.geocode || null,
          addressComponents: data.addressComponents || null,
          metadata: {
            confidence: data.metadata?.confidence || "UNKNOWN",
            granularity: data.metadata?.granularity || "UNKNOWN",
            hasUnconfirmedComponents:
              data.metadata?.hasUnconfirmedComponents || false,
            hasInferredComponents:
              data.metadata?.hasInferredComponents || false,
          },
          originalAddress: address,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[AddressValidatorTool] Error:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      return JSON.stringify(
        {
          success: false,
          isValid: false,
          summary: `Address validation failed: ${errorMessage}. The validation service may be unavailable. You can still try searching for properties with this address.`,
          formattedAddress: null,
          geocode: null,
          addressComponents: null,
          metadata: {
            confidence: "UNKNOWN",
            granularity: "UNKNOWN",
            hasUnconfirmedComponents: false,
            hasInferredComponents: false,
          },
          originalAddress: address,
          error: errorMessage,
        },
        null,
        2,
      );
    }
  },
});
