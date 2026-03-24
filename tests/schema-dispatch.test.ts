import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredExtractor } from '../src/index';
import { ExtractionFatalError } from '../src/errors';
import type { LLMClient } from '../src/llm-client';
import type { JSONSchema } from '../src/schema';
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

const stringSchema: JSONSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};

const integerSchema: JSONSchema = {
  type: 'object',
  properties: { value: { type: 'integer' } },
  required: ['value'],
  additionalProperties: false,
};

describe('Schema dispatch (real Ajv)', () => {
  it('tv-schema-01 — Fonction appelée avec variables post-injection', async () => {
    llmClient = mockLLMClient('{"name":"A","age":1}');
    extractor = new StructuredExtractor(llmClient);
    const outputSchemaFn = vi.fn(
      () => simpleContract.outputSchema as JSONSchema,
    );
    const contract = { ...simpleContract, outputSchema: outputSchemaFn };

    await extractor.extract('response text', contract, {
      reason: 'UNCLOSED_FENCE',
    });

    expect(outputSchemaFn).toHaveBeenCalledOnce();
    expect(outputSchemaFn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'UNCLOSED_FENCE',
        agent_response: 'response text',
      }),
    );
  });

  it("tv-schema-02 — Schema varie selon l'input (mode string)", async () => {
    llmClient = mockLLMClient('{"value":"hello"}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      outputSchema: (vars: Record<string, string>) =>
        vars['mode'] === 'string' ? stringSchema : integerSchema,
      parse: (raw: unknown) => raw as { value: string },
    };

    const { result } = await extractor.extract('valid', contract, {
      mode: 'string',
    });

    expect(result).toEqual({ value: 'hello' });
  });

  it("tv-schema-03 — Schema varie selon l'input (mode integer)", async () => {
    llmClient = mockLLMClient('{"value":42}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      outputSchema: (vars: Record<string, string>) =>
        vars['mode'] === 'string' ? stringSchema : integerSchema,
      parse: (raw: unknown) => raw as { value: number },
    };

    const { result } = await extractor.extract('valid', contract, {
      mode: 'integer',
    });

    expect(result).toEqual({ value: 42 });
  });

  it('tv-schema-04 — Schema dynamique rejette le mauvais type', async () => {
    llmClient = mockLLMClient('{"value":"hello"}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      outputSchema: (vars: Record<string, string>) =>
        vars['mode'] === 'string' ? stringSchema : integerSchema,
      parse: (raw: unknown) => raw as { value: number },
    };

    const error = await extractor
      .extract('valid', contract, { mode: 'integer' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('SCHEMA_VIOLATION');
  });
});
