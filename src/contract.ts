import type { JSONSchema } from './schema';

export interface ExtractionContract<T> {
  id: string;
  sourceAgent: string;
  contextDescription: string;
  extractionPrompt: string;
  outputSchema: JSONSchema | ((variables: Record<string, string>) => JSONSchema);
  maxTokens?: number;
  parse(raw: unknown): T;
}
