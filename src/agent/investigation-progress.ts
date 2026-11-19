import type { ToolDefinition } from '../tools/registry.js';

/** A reminder about repeated evidence, not a claim that an investigation must edit files. */
export class InvestigationProgress {
  private evidence: Array<{ name: string; output: string }> = [];

  observe(tool: ToolDefinition | undefined, output: unknown): boolean {
    if (tool?.isReadOnly !== true) {
      this.evidence = [];
      return false;
    }
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    if (!text) return false;
    this.evidence.push({ name: tool.name, output: text });
    if (this.evidence.length > 12) this.evidence.shift();
    if (this.evidence.length < 8) return false;

    const repeats = this.evidence.filter((entry, index, all) =>
      all.slice(0, index).some(previous => previous.name === entry.name && previous.output === entry.output)
    ).length;
    if (repeats < 3) return false;
    this.evidence = [];
    return true;
  }
}
