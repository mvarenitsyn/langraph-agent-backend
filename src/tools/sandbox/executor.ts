/**
 * Sandbox Executor using vm2
 *
 * Provides secure JavaScript execution with:
 * - Sandboxed VM context
 * - Timeout protection (5 seconds)
 * - Safe helper functions only
 * - No access to require/process/etc
 */

import { VM, VMScript } from 'vm2';
import { validateCode, validateFilterCode, validateSortCode, sanitizeError } from './validators.js';

// Resource limits
const TIMEOUT_MS = 5000;
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB output limit

export interface ExecutionResult<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
  executionTimeMs: number;
}

/**
 * Create helper functions code string
 */
function getHelperCode(properties: Record<string, unknown>[]): string {
  return `
    // Properties data
    const properties = ${JSON.stringify(properties)};

    // Safe Math subset
    const Math = {
      min: (...args) => args.reduce((a, b) => a < b ? a : b),
      max: (...args) => args.reduce((a, b) => a > b ? a : b),
      round: (n) => n >= 0 ? (n + 0.5) | 0 : (n - 0.5) | 0,
      floor: (n) => n | 0,
      ceil: (n) => n >= 0 ? ((n | 0) + (n % 1 > 0 ? 1 : 0)) : (n | 0),
      abs: (n) => n < 0 ? -n : n,
    };

    // Helper: Convert value to number (handles strings like "899000.00")
    function toNumber(val) {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const parsed = parseFloat(val);
        return isNaN(parsed) ? null : parsed;
      }
      return null;
    }

    // Helper: Get numeric values from a field (handles both numbers and numeric strings)
    function getNumericValues(field) {
      return properties
        .map(p => toNumber(p[field]))
        .filter(v => v !== null && !isNaN(v));
    }

    // Helper: Sum values of a field
    function sum(field) {
      const values = getNumericValues(field);
      return values.reduce((acc, val) => acc + val, 0);
    }

    // Helper: Average values of a field
    function avg(field) {
      const values = getNumericValues(field);
      if (values.length === 0) return null;
      return values.reduce((a, b) => a + b, 0) / values.length;
    }

    // Helper: Min value of a field
    function min(field) {
      const values = getNumericValues(field);
      if (values.length === 0) return null;
      return Math.min(...values);
    }

    // Helper: Max value of a field
    function max(field) {
      const values = getNumericValues(field);
      if (values.length === 0) return null;
      return Math.max(...values);
    }

    // Helper: Group properties by field value
    function groupBy(field) {
      const groups = {};
      for (const p of properties) {
        const key = String(p[field] ?? 'null');
        if (!groups[key]) groups[key] = [];
        groups[key].push(p);
      }
      return groups;
    }

    // Helper: Count properties by field value
    function countBy(field) {
      const counts = {};
      for (const p of properties) {
        const key = String(p[field] ?? 'null');
        counts[key] = (counts[key] || 0) + 1;
      }
      return counts;
    }

    // Helper: Unique values of a field
    function unique(field) {
      const seen = new Set();
      for (const p of properties) {
        if (p[field] !== undefined && p[field] !== null) {
          seen.add(p[field]);
        }
      }
      return Array.from(seen);
    }

    // Helper: Filter properties
    function filter(fn) {
      return properties.filter(fn);
    }
  `;
}

/**
 * Execute analysis code in sandbox
 *
 * Available in sandbox:
 * - properties: Array of property objects
 * - sum(field): Sum values of a field
 * - avg(field): Average values of a field
 * - min(field): Minimum value of a field
 * - max(field): Maximum value of a field
 * - groupBy(field): Group properties by field value
 * - countBy(field): Count properties by field value
 */
export async function executeAnalysis(
  code: string,
  properties: Record<string, unknown>[]
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Validate code
  const validation = validateCode(code);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      executionTimeMs: Date.now() - startTime
    };
  }

  try {
    // Create sandboxed VM
    const vm = new VM({
      timeout: TIMEOUT_MS,
      sandbox: {},
      eval: false,
      wasm: false,
    });

    // Build full code with helpers and user code
    const fullCode = `
      ${getHelperCode(properties)}

      // User code (wrapped to return result)
      (${code})
    `;

    // Compile and run
    const script = new VMScript(fullCode);
    const result = vm.run(script);

    // Validate output size
    const outputStr = JSON.stringify(result);
    if (outputStr && outputStr.length > MAX_OUTPUT_SIZE) {
      return {
        success: false,
        error: `Output exceeds maximum size of ${MAX_OUTPUT_SIZE} bytes`,
        executionTimeMs: Date.now() - startTime
      };
    }

    return {
      success: true,
      result: result,
      executionTimeMs: Date.now() - startTime
    };

  } catch (error) {
    return {
      success: false,
      error: sanitizeError(error),
      executionTimeMs: Date.now() - startTime
    };
  }
}

/**
 * Execute filter code in sandbox
 * Returns filtered properties
 */
export async function executeFilter(
  filterCode: string,
  properties: Record<string, unknown>[],
  sortCode?: string,
  limit: number = 20
): Promise<ExecutionResult<Record<string, unknown>[]>> {
  const startTime = Date.now();

  // Validate filter code
  const filterValidation = validateFilterCode(filterCode);
  if (!filterValidation.valid) {
    return {
      success: false,
      error: filterValidation.error,
      executionTimeMs: Date.now() - startTime
    };
  }

  // Validate sort code if provided
  if (sortCode) {
    const sortValidation = validateSortCode(sortCode);
    if (!sortValidation.valid) {
      return {
        success: false,
        error: sortValidation.error,
        executionTimeMs: Date.now() - startTime
      };
    }
  }

  try {
    // Create sandboxed VM
    const vm = new VM({
      timeout: TIMEOUT_MS,
      sandbox: {},
      eval: false,
      wasm: false,
    });

    // Build execution code
    let execCode = `
      const properties = ${JSON.stringify(properties)};
      const limit = ${limit};

      const filterFn = (p) => ${filterCode};
      let result = properties.filter(filterFn);
    `;

    if (sortCode) {
      execCode += `
      const sortFn = (a, b) => ${sortCode};
      result = result.sort(sortFn);
      `;
    }

    execCode += `
      result.slice(0, limit);
    `;

    const script = new VMScript(execCode);
    const result = vm.run(script) as Record<string, unknown>[];

    return {
      success: true,
      result: result,
      executionTimeMs: Date.now() - startTime
    };

  } catch (error) {
    return {
      success: false,
      error: sanitizeError(error),
      executionTimeMs: Date.now() - startTime
    };
  }
}

/**
 * Cleanup (no-op for vm2, kept for interface compatibility)
 */
export function disposeIsolate(): void {
  // No cleanup needed for vm2
}
