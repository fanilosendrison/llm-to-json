import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LLMClient } from '../src/llm-client';
import { ExtractionFatalError } from '../src/errors';
import type { JSONSchema } from '../src/schema';
import { mockLLMClient, simpleContract } from './helpers';

// --- Ajv mock setup (vi.hoisted ensures availability before vi.mock) ---
const { removeSchemaSpy, compileSpy, errorsTextSpy } = vi.hoisted(() => ({
  removeSchemaSpy: vi.fn(),
  compileSpy: vi.fn(),
  errorsTextSpy: vi.fn(() => 'mock error'),
}));

vi.mock('ajv', () => ({
  default: vi.fn().mockImplementation(() => ({
    compile: compileSpy.mockImplementation((schema: unknown) => {
      void schema;
      const validate = vi.fn(() => true) as unknown as ((
        data: unknown,
      ) => boolean) & { errors: null | Array<{ message: string }> };
      validate.errors = null;
      return validate;
    }),
    removeSchema: removeSchemaSpy,
    errorsText: errorsTextSpy,
  })),
}));

// Import AFTER mock setup
import { StructuredExtractor } from '../src/extractor';

let extractor: StructuredExtractor;
let llmClient: LLMClient;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  removeSchemaSpy.mockClear();
  compileSpy.mockClear();
  errorsTextSpy.mockClear();
  llmClient = mockLLMClient('{"name":"default","age":0}');
  extractor = new StructuredExtractor(llmClient);
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

function dynamicSchema(): JSONSchema {
  return {
    type: 'object',
    properties: { x: { type: 'string' } },
    required: ['x'],
    additionalProperties: false,
  };
}

describe('Schema lifecycle (mocked Ajv)', () => {
  it('tv-schema-05 — [NORMATIF] removeSchema appelé pour schema dynamique (happy path)', async () => {
    llmClient = mockLLMClient('{"x":"valid"}');
    extractor = new StructuredExtractor(llmClient);
    const schemaObj = dynamicSchema();
    const outputSchemaFn = vi.fn(() => schemaObj);
    const contract = {
      ...simpleContract,
      outputSchema: outputSchemaFn,
      parse: (raw: unknown) => raw as { name: string; age: number },
    };

    await extractor.extract('valid', contract, {});

    expect(removeSchemaSpy).toHaveBeenCalledOnce();
    expect(removeSchemaSpy).toHaveBeenCalledWith(schemaObj);
    // Same reference, not a copy
    expect(removeSchemaSpy.mock.calls[0]![0]).toBe(schemaObj);
  });

  it('tv-schema-06 — removeSchema PAS appelé pour schema statique', async () => {
    llmClient = mockLLMClient('{"name":"B","age":2}');
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {});

    expect(removeSchemaSpy).not.toHaveBeenCalled();
  });

  it('tv-schema-07 — [NORMATIF] removeSchema même en cas de SCHEMA_VIOLATION (schema dynamique)', async () => {
    llmClient = mockLLMClient('{"x":"valid"}');
    extractor = new StructuredExtractor(llmClient);

    // Override compile to return a failing validate function
    compileSpy.mockImplementationOnce((_schema: unknown) => {
      const validate = vi.fn(() => false) as unknown as ((
        data: unknown,
      ) => boolean) & { errors: Array<{ message: string }> };
      validate.errors = [{ message: 'mock violation' }];
      return validate;
    });

    const contract = {
      ...simpleContract,
      outputSchema: vi.fn(() => dynamicSchema()),
      parse: (raw: unknown) => raw as { name: string; age: number },
    };

    await expect(
      extractor.extract('valid', contract, {}),
    ).rejects.toBeInstanceOf(ExtractionFatalError);

    expect(removeSchemaSpy).toHaveBeenCalledOnce();
  });

  it('tv-schema-08 — [NORMATIF] removeSchema PAS appelé quand JSON.parse échoue (schema dynamique)', async () => {
    llmClient = mockLLMClient('not json');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      outputSchema: vi.fn(() => dynamicSchema()),
      parse: (raw: unknown) => raw as { name: string; age: number },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('INVALID_JSON');
    expect(removeSchemaSpy).not.toHaveBeenCalled();
    expect(compileSpy).not.toHaveBeenCalled();
  });

  it('tv-schema-09 — removeSchema même en cas de PARSE_ERROR (schema dynamique)', async () => {
    llmClient = mockLLMClient('{"x":"valid"}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      outputSchema: vi.fn(() => dynamicSchema()),
      parse: (): never => {
        throw new Error('invariant');
      },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('PARSE_ERROR');
    expect(removeSchemaSpy).toHaveBeenCalledOnce();
  });

  it('tv-schema-10 — [NORMATIF] removeSchema PAS appelé quand compile() throw (schema dynamique)', async () => {
    llmClient = mockLLMClient('{"anything":true}');
    extractor = new StructuredExtractor(llmClient);

    // Make compile throw
    compileSpy.mockImplementationOnce(() => {
      throw new Error('schema is invalid');
    });

    const contract = {
      ...simpleContract,
      outputSchema: vi.fn(() => ({ type: 'invalid_type_here' }) as JSONSchema),
      parse: (raw: unknown) => raw as { name: string; age: number },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ExtractionFatalError);
    expect(error).toBeInstanceOf(Error);
    expect(compileSpy).toHaveBeenCalledOnce();
    expect(removeSchemaSpy).not.toHaveBeenCalled();
  });
});
