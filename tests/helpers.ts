import { vi } from 'vitest';
import type { LLMClient } from '../src/llm-client';
import type { ExtractionContract } from '../src/contract';

export function mockLLMClient(response: string): LLMClient {
  return { complete: vi.fn().mockResolvedValue(response) };
}

export function mockLLMClientRejecting(error: Error): LLMClient {
  return { complete: vi.fn().mockRejectedValue(error) };
}

export const simpleContract: ExtractionContract<{
  name: string;
  age: number;
}> = {
  id: 'TEST-01',
  sourceAgent: 'TestAgent',
  contextDescription: 'Context for {{agent_response}}',
  extractionPrompt: 'Extract from: {{agent_response}}',
  outputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'integer', minimum: 0 },
    },
    required: ['name', 'age'],
    additionalProperties: false,
  },
  parse(raw) {
    return raw as { name: string; age: number };
  },
};
