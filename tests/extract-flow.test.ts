import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredExtractor } from '../src/index';
import { TemplateInterpolationError } from '../src/errors';
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

describe('Extract flow wiring & happy path', () => {
  it('tv-flow-01 — Happy path complet (JSON valide, schema OK, parse OK → T)', async () => {
    llmClient = mockLLMClient('{"name":"Alice","age":30}');
    extractor = new StructuredExtractor(llmClient);

    const { result, rawOutput } = await extractor.extract('raw input', simpleContract, {});

    expect(result).toEqual({ name: 'Alice', age: 30 });
    expect(rawOutput).toBe('{"name":"Alice","age":30}');
  });

  it('tv-flow-02 — complete reçoit system interpolé, user interpolé, config correcte', async () => {
    llmClient = mockLLMClient('{"name":"Bob","age":25}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription: 'System: {{agent_response}}',
      extractionPrompt: 'User: {{agent_response}}',
      maxTokens: 2048,
    };

    await extractor.extract('test input', contract, {});

    expect(llmClient.complete).toHaveBeenCalledOnce();
    expect(llmClient.complete).toHaveBeenCalledWith(
      'System: test input',
      'User: test input',
      { temperature: 0, maxTokens: 2048 },
    );
  });

  it('tv-flow-03 — [NORMATIF] temperature: 0 fixe dans appel LLM', async () => {
    llmClient = mockLLMClient('{"name":"C","age":1}');
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {});

    const config = (llmClient.complete as ReturnType<typeof vi.fn>).mock
      .calls[0]![2] as { temperature: number };
    expect(config.temperature).toBe(0);
  });

  it('tv-flow-04 — maxTokens par défaut = 1024', async () => {
    llmClient = mockLLMClient('{"name":"D","age":2}');
    extractor = new StructuredExtractor(llmClient);

    await extractor.extract('valid', simpleContract, {});

    const config = (llmClient.complete as ReturnType<typeof vi.fn>).mock
      .calls[0]![2] as { maxTokens: number };
    expect(config.maxTokens).toBe(1024);
  });

  it('tv-flow-05 — Clone défensif (dictionnaire original non muté)', async () => {
    llmClient = mockLLMClient('{"name":"E","age":3}');
    extractor = new StructuredExtractor(llmClient);
    const vars = { myKey: 'myValue' };

    await extractor.extract('input', simpleContract, vars);

    expect(vars).toEqual({ myKey: 'myValue' });
    expect(vars).not.toHaveProperty('agent_response');
  });

  it('tv-flow-06 — Injection automatique de agent_response', async () => {
    llmClient = mockLLMClient('{"name":"F","age":4}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      extractionPrompt: 'Analyze: {{agent_response}}',
    };

    await extractor.extract('This is the raw response', contract, {});

    expect(llmClient.complete).toHaveBeenCalledWith(
      expect.any(String),
      'Analyze: This is the raw response',
      expect.any(Object),
    );
  });

  it('tv-flow-07 — agent_response fourni par appelant est ecrase', async () => {
    llmClient = mockLLMClient('{"name":"G","age":5}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      extractionPrompt: '{{agent_response}}',
    };

    await extractor.extract('real response', contract, {
      agent_response: 'should be overwritten',
    });

    expect(llmClient.complete).toHaveBeenCalledWith(
      expect.any(String),
      'real response',
      expect.any(Object),
    );
  });

  it('tv-flow-08 — parse() reçoit le retour brut de JSON.parse (non transformé)', async () => {
    llmClient = mockLLMClient('{"name":"H","age":6}');
    extractor = new StructuredExtractor(llmClient);
    const parseSpy = vi.fn((raw: unknown) => raw);
    const contract = { ...simpleContract, parse: parseSpy };

    const { result } = await extractor.extract('valid', contract, {});

    expect(parseSpy).toHaveBeenCalledWith({ name: 'H', age: 6 });
    // Identity check: same reference from JSON.parse → parse → return
    expect(parseSpy.mock.calls[0]![0]).toBe(result);
  });

  it('tv-flow-09 — Retour de parse() est le résultat final de extract()', async () => {
    llmClient = mockLLMClient('{"name":"I","age":7}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      parse: () => ({ transformed: true }) as unknown as {
        name: string;
        age: number;
      },
    };

    const { result } = await extractor.extract('valid', contract, {});

    expect(result).toEqual({ transformed: true });
  });

  it('tv-flow-10 — Ordre des validations : agentResponse (step 1) avant maxTokens (step 3)', async () => {
    const contract = { ...simpleContract, maxTokens: 3.5 };

    const error = await extractor
      .extract('', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      'agentResponse must be a non-empty string',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-flow-11 — Ordre : interpolation (step 4) avant schema resolution (step 5)', async () => {
    const contract = {
      ...simpleContract,
      contextDescription: '{{missing_var}}',
      outputSchema: () => {
        throw new Error('should not reach schema resolution');
      },
    };

    const error = await extractor
      .extract('valid', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemplateInterpolationError);
    expect((error as TemplateInterpolationError).variableName).toBe(
      'missing_var',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-flow-12 — Ordre : maxTokens (step 3) avant interpolation (step 4)', async () => {
    const contract = {
      ...simpleContract,
      maxTokens: -1,
      contextDescription: '{{missing_var}}',
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
