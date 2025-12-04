import { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Tools Registry
 *
 * Central registry for managing all tools available to the agent.
 * Provides methods to register, retrieve, and manage tools.
 */

export class ToolsRegistry {
  private tools: Map<string, DynamicStructuredTool>;

  constructor() {
    this.tools = new Map();
  }

  /**
   * Register a single tool
   */
  register(tool: DynamicStructuredTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(
        `[ToolsRegistry] Tool "${tool.name}" already registered. Overwriting...`,
      );
    }
    this.tools.set(tool.name, tool);
    console.log(`[ToolsRegistry] ✓ Registered tool: ${tool.name}`);
  }

  /**
   * Register multiple tools at once
   */
  registerBatch(tools: DynamicStructuredTool[]): void {
    tools.forEach((tool) => this.register(tool));
  }

  /**
   * Get a specific tool by name
   */
  getTool(name: string): DynamicStructuredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools as an array
   */
  getAllTools(): DynamicStructuredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool is registered
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      console.log(`[ToolsRegistry] ✓ Unregistered tool: ${name}`);
    }
    return deleted;
  }

  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear();
    console.log("[ToolsRegistry] ✓ Cleared all tools");
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalTools: number;
    toolNames: string[];
  } {
    return {
      totalTools: this.tools.size,
      toolNames: this.getToolNames(),
    };
  }
}

// Global singleton instance
export const globalToolsRegistry = new ToolsRegistry();
