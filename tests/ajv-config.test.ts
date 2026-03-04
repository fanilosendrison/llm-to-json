import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredExtractor } from '../src/index';
import { ExtractionFatalError } from '../src/errors';
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

describe('Ajv configuration', () => {
  it('tv-ajv-01 — coerceTypes: false (pas de coercion string → number)', async () => {
    llmClient = mockLLMClient('{"name":"A","age":"30"}');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('SCHEMA_VIOLATION');
  });

  it('tv-ajv-02 — useDefaults: false (pas de mutation par defaults)', async () => {
    llmClient = mockLLMClient('{"name":"B"}');
    extractor = new StructuredExtractor(llmClient);
    const parseSpy = vi.fn((raw: unknown) => raw);
    const contract = {
      ...simpleContract,
      outputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          role: { type: 'string' as const, default: 'user' },
        },
        required: ['name'] as string[],
        additionalProperties: false,
      },
      parse: parseSpy,
    };

    await extractor.extract('valid', contract, {});

    // role NOT added by Ajv — useDefaults: false
    expect(parseSpy).toHaveBeenCalledWith({ name: 'B' });
  });

  it('tv-ajv-03 — allErrors: false (fail-fast)', async () => {
    llmClient = mockLLMClient('{"wrong":"everything"}');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBe('SCHEMA_VIOLATION');
    // allErrors: false → single error, no ", data" separator
    expect(fatal.details).toBeDefined();
    expect(fatal.details).not.toMatch(/, data/);
  });

  it('tv-ajv-04 — Schema malformé → erreur compilation Ajv propage directement', async () => {
    llmClient = mockLLMClient('{"anything":true}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      outputSchema: { type: 'invalid_type_here' },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ExtractionFatalError);
    expect(error).toBeInstanceOf(Error);
    // Must be an Ajv compile error, not the stub's "Not implemented"
    expect((error as Error).message).not.toBe('Not implemented');
  });
});
