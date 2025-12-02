/**
 * Sandbox Code Validators
 *
 * Layer 1 of security: Static code validation before execution.
 * Detects dangerous patterns and enforces size limits.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// Maximum code size (10KB)
const MAX_CODE_SIZE = 10000;

// Forbidden patterns that could escape sandbox or cause issues
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Infinite loops
  { pattern: /while\s*\(\s*true\s*\)/, description: 'Infinite while(true) loop' },
  { pattern: /for\s*\(\s*;\s*;\s*\)/, description: 'Infinite for(;;) loop' },

  // Prototype pollution
  { pattern: /__proto__/, description: 'Prototype access (__proto__)' },
  { pattern: /constructor\s*\[/, description: 'Constructor bracket access' },
  { pattern: /prototype\s*\[/, description: 'Prototype bracket access' },

  // Dynamic code execution
  { pattern: /Function\s*\(/, description: 'Dynamic Function constructor' },
  { pattern: /eval\s*\(/, description: 'eval() function' },
  { pattern: /new\s+Function/, description: 'new Function() constructor' },

  // Module loading (shouldn't work in isolate but block anyway)
  { pattern: /require\s*\(/, description: 'require() function' },
  { pattern: /import\s*\(/, description: 'Dynamic import()' },
  { pattern: /import\s+/, description: 'Import statement' },

  // Process/global access attempts
  { pattern: /process\./, description: 'process object access' },
  { pattern: /global\./, description: 'global object access' },
  { pattern: /globalThis\./, description: 'globalThis access' },

  // File system attempts
  { pattern: /fs\./, description: 'fs module access' },
  { pattern: /child_process/, description: 'child_process access' },

  // Network attempts
  { pattern: /fetch\s*\(/, description: 'fetch() function' },
  { pattern: /XMLHttpRequest/, description: 'XMLHttpRequest' },
  { pattern: /WebSocket/, description: 'WebSocket' },

  // Async patterns that could hang
  { pattern: /async\s+function/, description: 'async function' },
  { pattern: /await\s+/, description: 'await keyword' },
  { pattern: /new\s+Promise/, description: 'Promise constructor' },

  // Dangerous object access
  { pattern: /Object\.defineProperty/, description: 'Object.defineProperty' },
  { pattern: /Object\.setPrototypeOf/, description: 'Object.setPrototypeOf' },
  { pattern: /Reflect\./, description: 'Reflect object' },
  { pattern: /Proxy\s*\(/, description: 'Proxy constructor' },
];

// Allowed safe patterns for whitelisted functionality
const SAFE_PATTERNS = [
  /^[a-zA-Z_$][a-zA-Z0-9_$]*$/, // Simple identifier
  /properties\./, // Properties array access
  /Math\.(min|max|round|floor|ceil|abs|sqrt|pow)/, // Safe Math functions
  /JSON\.(stringify|parse)/, // JSON functions
  /\.(filter|map|reduce|forEach|find|some|every|slice|sort|length)/, // Array methods
  /\.(keys|values|entries)/, // Object methods
  /\.(toLowerCase|toUpperCase|includes|startsWith|endsWith|split|trim)/, // String methods
];

/**
 * Validate code before sandbox execution
 */
export function validateCode(code: string): ValidationResult {
  // Check size limit
  if (code.length > MAX_CODE_SIZE) {
    return {
      valid: false,
      error: `Code exceeds maximum size of ${MAX_CODE_SIZE} characters (got ${code.length})`
    };
  }

  // Check for empty code
  if (!code.trim()) {
    return {
      valid: false,
      error: 'Code cannot be empty'
    };
  }

  // Check for forbidden patterns
  for (const { pattern, description } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return {
        valid: false,
        error: `Forbidden pattern detected: ${description}`
      };
    }
  }

  // Check for deeply nested brackets (potential DoS)
  const maxNesting = 10;
  let currentNesting = 0;
  let maxFound = 0;
  for (const char of code) {
    if (char === '(' || char === '[' || char === '{') {
      currentNesting++;
      maxFound = Math.max(maxFound, currentNesting);
    } else if (char === ')' || char === ']' || char === '}') {
      currentNesting--;
    }
  }
  if (maxFound > maxNesting) {
    return {
      valid: false,
      error: `Code nesting too deep (max ${maxNesting}, found ${maxFound})`
    };
  }

  return { valid: true };
}

/**
 * Validate filter code specifically (p => condition)
 */
export function validateFilterCode(code: string): ValidationResult {
  // First run general validation
  const generalResult = validateCode(code);
  if (!generalResult.valid) {
    return generalResult;
  }

  // Filter code should reference 'p' (the property object)
  if (!code.includes('p.') && !code.includes('p[')) {
    return {
      valid: false,
      error: 'Filter code must reference property fields using p.fieldName'
    };
  }

  return { valid: true };
}

/**
 * Validate sort code specifically ((a, b) => comparison)
 */
export function validateSortCode(code: string): ValidationResult {
  // First run general validation
  const generalResult = validateCode(code);
  if (!generalResult.valid) {
    return generalResult;
  }

  // Sort code should reference both 'a' and 'b'
  const hasA = code.includes('a.') || code.includes('a[');
  const hasB = code.includes('b.') || code.includes('b[');

  if (!hasA || !hasB) {
    return {
      valid: false,
      error: 'Sort code must reference both a and b (e.g., a.price - b.price)'
    };
  }

  return { valid: true };
}

/**
 * Sanitize error messages to prevent information leakage
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Remove stack traces and internal paths
    const message = error.message
      .replace(/at\s+.*:\d+:\d+/g, '')
      .replace(/\/[^\s]+\//g, '')
      .substring(0, 200);
    return `Execution error: ${message}`;
  }
  return 'Unknown execution error';
}

/**
 * Validate and sanitize field name for regex use
 */
export function sanitizeFieldFilter(filter: string | undefined): RegExp | null {
  if (!filter) return null;

  // Only allow alphanumeric, underscore, and pipe (for OR)
  const sanitized = filter.replace(/[^a-zA-Z0-9_|]/g, '');
  if (!sanitized) return null;

  try {
    return new RegExp(sanitized, 'i');
  } catch {
    return null;
  }
}
