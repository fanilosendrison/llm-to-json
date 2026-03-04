import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredExtractor } from '../src/index';
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

/** Parse and validate a log entry from consoleSpy at the given call index. */
function parseLogEntry(callIndex: number): Record<string, unknown> {
  const call = consoleSpy.mock.calls[callIndex];
  expect(call).toHaveLength(1);
  expect(typeof call![0]).toBe('string');
  return JSON.parse(call![0] as string) as Record<string, unknown>;
}

describe('Structured logging', () => {
  it('tv-log-01 — [NORMATIF] extract_start émis AVANT toute validation', async () => {
    await extractor.extract('', simpleContract, {}).catch(() => {});

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const start = parseLogEntry(0);
    expect(start['event']).toBe('extract_start');
    expect(start['contractId']).toBe('TEST-01');
    expect(start['sourceAgent']).toBe('TestAgent');
    expect(typeof start['timestamp']).toBe('string');
    expect(
      Number.isNaN(new Date(start['timestamp'] as string).getTime()),
    ).toBe(false);

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['success']).toBe(false);
    expect(end['errorType']).toBe('TypeError');
  });

  it('tv-log-02 — extract_end avec success: true (happy path)', async () => {
    llmClient = mockLLMClient('{"name":"A","age":1}');
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {});

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['contractId']).toBe('TEST-01');
    expect(end['sourceAgent']).toBe('TestAgent');
    expect(end['success']).toBe(true);
    expect(end).not.toHaveProperty('errorType');
    expect(typeof end['timestamp']).toBe('string');
    expect(
      Number.isNaN(new Date(end['timestamp'] as string).getTime()),
    ).toBe(false);
  });

  it('tv-log-03 — extract_end avec errorType pour ExtractionFatalError', async () => {
    llmClient = mockLLMClient('not json');
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {}).catch(() => {});

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['contractId']).toBe('TEST-01');
    expect(end['sourceAgent']).toBe('TestAgent');
    expect(end['success']).toBe(false);
    expect(end['errorType']).toBe('INVALID_JSON');
  });

  it('tv-log-04 — errorType = error.name pour TypeError', async () => {
    await extractor.extract('', simpleContract, {}).catch(() => {});

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['success']).toBe(false);
    expect(end['errorType']).toBe('TypeError');
  });

  it('tv-log-05 — errorType pour TemplateInterpolationError', async () => {
    const contract = {
      ...simpleContract,
      contextDescription: '{{missing}}',
    };

    await extractor.extract('valid', contract, {}).catch(() => {});

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['success']).toBe(false);
    expect(end['errorType']).toBe('TemplateInterpolationError');
  });

  it('tv-log-06 — Format = JSON.stringify (un seul argument string)', async () => {
    llmClient = mockLLMClient('{"name":"B","age":2}');
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {});

    for (let i = 0; i < consoleSpy.mock.calls.length; i++) {
      const call = consoleSpy.mock.calls[i];
      expect(call).toHaveLength(1);
      expect(typeof call![0]).toBe('string');
      // Must be parseable JSON
      expect(() => JSON.parse(call![0] as string)).not.toThrow();
    }
  });

  it('tv-log-07 — Pairing garanti (erreur LLMClient → extract_start + extract_end)', async () => {
    llmClient = mockLLMClientRejecting(new Error('network'));
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {}).catch(() => {});

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const start = parseLogEntry(0);
    expect(start['event']).toBe('extract_start');

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['success']).toBe(false);
    expect(end['errorType']).toBe('Error');
  });

  it("tv-log-08 — errorType: unknown quand l'erreur n'a pas de name", async () => {
    const rejectedObj = { message: 'bare object' };
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(rejectedObj),
    };
    const ext = new StructuredExtractor(client);

    try {
      await ext.extract('valid', simpleContract, {});
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBe(rejectedObj);
    }

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['success']).toBe(false);
    expect(end['errorType']).toBe('unknown');
  });

  it('tv-log-09 — [NORMATIF] errorType utilise instanceof pas duck-typing', async () => {
    class APIError extends Error {
      type = 'RATE_LIMIT';
      constructor() {
        super('rate limited');
        this.name = 'APIError';
      }
    }

    const apiError = new APIError();
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(apiError),
    };
    const ext = new StructuredExtractor(client);

    const error = await ext
      .extract('valid', simpleContract, {})
      .catch((e: unknown) => e);

    expect(error).toBe(apiError);

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const end = parseLogEntry(1);
    expect(end['event']).toBe('extract_end');
    expect(end['success']).toBe(false);
    // Must be 'APIError' (from error.name), NOT 'RATE_LIMIT' (from error.type)
    expect(end['errorType']).toBe('APIError');
  });
});
