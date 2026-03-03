import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredExtractor } from '../src/index';
import { ExtractionFatalError } from '../src/errors';
import type { LLMClient } from '../src/llm-client';
import { mockLLMClient, mockLLMClientRejecting, simpleContract } from './helpers';

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

describe('Error paths', () => {
  it('tv-err-01 — agentResponse vide → TypeError', async () => {
    const error = await extractor
      .extract('', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ExtractionFatalError);
    expect((error as TypeError).message).toBe(
      'agentResponse must be a non-empty string',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-02 — [NORMATIF] agentResponse whitespace-only → TypeError', async () => {
    const error = await extractor
      .extract('   \n  ', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      'agentResponse must be a non-empty string',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-03 — maxTokens non-entier → TypeError', async () => {
    const contract = { ...simpleContract, maxTokens: 3.5 };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      'maxTokens must be a positive integer',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-04 — maxTokens = 0 → TypeError', async () => {
    const contract = { ...simpleContract, maxTokens: 0 };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      'maxTokens must be a positive integer',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-05 — maxTokens négatif → TypeError', async () => {
    const contract = { ...simpleContract, maxTokens: -1 };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-06 — INVALID_JSON (réponse non-JSON)', async () => {
    llmClient = mockLLMClient('This is not JSON at all');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBe('INVALID_JSON');
    expect(fatal.rawOutput).toBe('This is not JSON at all');
    expect(fatal.contractId).toBe('TEST-01');
    expect(fatal.details).toBeDefined();
  });

  it('tv-err-07 — INVALID_JSON (markdown-wrapped — no strip)', async () => {
    llmClient = mockLLMClient('```json\n{"name":"A","age":1}\n```');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('INVALID_JSON');
  });

  it('tv-err-08 — SCHEMA_VIOLATION (champ requis manquant)', async () => {
    llmClient = mockLLMClient('{"name":"B"}');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBe('SCHEMA_VIOLATION');
    expect(fatal.rawOutput).toBe('{"name":"B"}');
    expect(fatal.details).toBeDefined();
  });

  it('tv-err-09 — SCHEMA_VIOLATION (type incorrect)', async () => {
    llmClient = mockLLMClient('{"name":"C","age":"not a number"}');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('SCHEMA_VIOLATION');
  });

  it('tv-err-10 — SCHEMA_VIOLATION (additionalProperties)', async () => {
    llmClient = mockLLMClient('{"name":"D","age":1,"extra":"field"}');
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    expect((error as ExtractionFatalError).type).toBe('SCHEMA_VIOLATION');
  });

  it('tv-err-11 — PARSE_ERROR (parse() throws Error)', async () => {
    llmClient = mockLLMClient('{"name":"E","age":5}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      parse: () => {
        throw new Error('count mismatch');
      },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBe('PARSE_ERROR');
    expect(fatal.details).toBe('count mismatch');
    expect(fatal.rawOutput).toBe('{"name":"E","age":5}');
  });

  it('tv-err-12 — PARSE_ERROR (parse() throws string)', async () => {
    llmClient = mockLLMClient('{"name":"F","age":6}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      parse: (): never => {
        throw 'raw string error';
      },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBe('PARSE_ERROR');
    expect(fatal.details).toBe('raw string error');
    expect(fatal.rawOutput).toBe('{"name":"F","age":6}');
  });

  it('tv-err-13 — PARSE_ERROR (parse() throws number)', async () => {
    llmClient = mockLLMClient('{"name":"G","age":7}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      parse: (): never => {
        throw 42;
      },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractionFatalError);
    const fatal = error as ExtractionFatalError;
    expect(fatal.type).toBe('PARSE_ERROR');
    expect(fatal.details).toBe('42');
    expect(fatal.rawOutput).toBe('{"name":"G","age":7}');
  });

  it('tv-err-14 — Erreur LLMClient propage telle quelle (pas wrappée)', async () => {
    const originalError = new Error('API timeout');
    llmClient = mockLLMClientRejecting(originalError);
    extractor = new StructuredExtractor(llmClient);

    const error = await extractor
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ExtractionFatalError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('API timeout');
    expect(error).toBe(originalError);
  });

  it('tv-err-15 — Erreur outputSchema dynamique propage telle quelle', async () => {
    const contract = {
      ...simpleContract,
      outputSchema: () => {
        throw new Error('bad reason');
      },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ExtractionFatalError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('bad reason');
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-16a — maxTokens null → TypeError', async () => {
    const contract = {
      ...simpleContract,
      maxTokens: null as unknown as number,
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      'maxTokens must be a positive integer',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-err-16b — maxTokens NaN → TypeError', async () => {
    const contract = {
      ...simpleContract,
      maxTokens: NaN as unknown as number,
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      'maxTokens must be a positive integer',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });
});
