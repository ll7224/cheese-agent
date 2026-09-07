import type { ToolResultPart } from 'ai';

export type ToolResultOutput = ToolResultPart['output'];

export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: 'text', value };
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'content':
      return output.value
        .map(part => {
          if (part.type === 'text') return part.text;
          if ('mediaType' in part && part.mediaType) return `[media: ${part.mediaType}]`;
          return `[${part.type}]`;
        })
        .join('\n');
    default:
      return '';
  }
}