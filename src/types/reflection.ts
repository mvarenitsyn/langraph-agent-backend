import { z } from 'zod';

/**
 * Zod schema for structured reflection output
 * Ensures reliable, type-safe parsing of reflection results
 */
export const ReflectionOutputSchema = z.object({
  qualityAssessment: z.enum(['HIGH', 'MEDIUM', 'LOW']).describe(
    'Overall quality of tool results: HIGH (excellent), MEDIUM (acceptable), LOW (insufficient)'
  ),
  completeness: z.enum(['COMPLETE', 'PARTIAL', 'INSUFFICIENT']).describe(
    'Whether results fully answer the user query'
  ),
  issues: z.string().describe(
    'List specific problems or "None" if no issues found'
  ),
  recommendation: z.enum(['PROCEED', 'RETRY', 'ERROR']).describe(
    'Next action: PROCEED (generate response), RETRY (try again), ERROR (critical failure)'
  ),
  reasoning: z.string().max(250).describe(
    'Brief explanation referencing tool criteria (max 250 characters)'
  ),
  recoveryStrategy: z.string().default('').describe(
    'ONLY if RETRY: specific actionable guidance on how to fix the issue (empty string if not RETRY)'
  ),
  issueAnalysis: z.string().default('').describe(
    'ONLY if RETRY: concise summary of what went wrong (empty string if not RETRY)'
  ),
});

/**
 * TypeScript type inferred from schema
 */
export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
