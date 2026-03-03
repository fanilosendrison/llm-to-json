import type { LLMClient } from './llm-client';
import type { ExtractionContract } from './contract';

export class StructuredExtractor {
  constructor(_llmClient: LLMClient) {}

  async extract<T>(
    _agentResponse: string,
    _contract: ExtractionContract<T>,
    _variables: Record<string, string>,
  ): Promise<T> {
    throw new Error('Not implemented');
  }
}
