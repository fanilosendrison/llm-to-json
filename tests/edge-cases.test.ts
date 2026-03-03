import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredExtractor } from '../src/index';
import {
  ExtractionFatalError,
  TemplateInterpolationError,
} from '../src/errors';
import type { LLMClient } from '../src/llm-client';
import { mockLLMClient, simpleContract } from './helpers';

let extractor: StructuredExtractor;
let llmClient: LLMClient;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  llmClient = mockLLMClient('{"name":"default","age":0}');
  extractor = new StructuredExtractor(llmClient);
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('Edge cases & idempotence', () => {
  it('tv-edge-01 — Instance Ajv réutilisée entre appels', async () => {
    llmClient = mockLLMClient('{"name":"A","age":1}');
    extractor = new StructuredExtractor(llmClient);

    const result1 = await extractor.extract('valid', simpleContract, {});
    const result2 = await extractor.extract('valid', simpleContract, {});

    expect(result1).toEqual({ name: 'A', age: 1 });
    expect(result2).toEqual({ name: 'A', age: 1 });
  });

  it('tv-edge-02 — StructuredExtractor est stateless entre appels', async () => {
    llmClient = mockLLMClient('{"name":"B","age":2}');
    extractor = new StructuredExtractor(llmClient);

    (llmClient.complete as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('{"name":"B","age":2}')
      .mockResolvedValueOnce('{"value":"hello"}');

    const contractB = {
      ...simpleContract,
      outputSchema: {
        type: 'object' as const,
        properties: { value: { type: 'string' as const } },
        required: ['value'] as string[],
        additionalProperties: false,
      },
      parse: (raw: unknown) => raw as { name: string; age: number },
    };

    const result1 = await extractor.extract('valid', simpleContract, {});
    const result2 = await extractor.extract('valid', contractB, {});

    expect(result1).toEqual({ name: 'B', age: 2 });
    expect(result2).toEqual({ value: 'hello' });
  });

  it('tv-edge-03 — ExtractionFatalError expose tous les champs documentés', async () => {
    llmClient = mockLLMClient('invalid');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBeDefined();
    expect(fatal.rawOutput).toBeDefined();
    expect(fatal.contractId).toBeDefined();
    expect(fatal.details).toBeDefined();
    // Inherits from Error
    expect(fatal).toBeInstanceOf(Error);
    expect(fatal.message).toBeDefined();
    expect(fatal.name).toBe('ExtractionFatalError');
    expect(fatal.stack).toBeDefined();
  });

  it('tv-edge-04 — TemplateInterpolationError expose tous les champs documentés', async () => {
    const contract = {
      ...simpleContract,
      contextDescription: '{{oops}}',
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemplateInterpolationError);
    const tipError = error as TemplateInterpolationError;
    expect(tipError.variableName).toBe('oops');
    expect(tipError.contractId).toBe('TEST-01');
    expect(tipError.templateField).toBe('contextDescription');
    expect(tipError.name).toBe('TemplateInterpolationError');
    expect(tipError).toBeInstanceOf(Error);
  });
});
