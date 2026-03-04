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

describe('Interpolation', () => {
  it('tv-interp-01 — Happy path, remplacement simple', async () => {
    llmClient = mockLLMClient('{"name":"A","age":1}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription: 'Agent {{agent_name}} said: {{agent_response}}',
    };

    await extractor.extract('The answer is 42', contract, {
      agent_name: 'Worker1',
    });

    expect(llmClient.complete).toHaveBeenCalledWith(
      'Agent Worker1 said: The answer is 42',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('tv-interp-02 — Variable manquante dans contextDescription → TemplateInterpolationError', async () => {
    const contract = {
      ...simpleContract,
      contextDescription: 'Hello {{unknown_var}}',
    };

    const error = await extractor
      .extract('anything', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemplateInterpolationError);
    const tipError = error as TemplateInterpolationError;
    expect(tipError.variableName).toBe('unknown_var');
    expect(tipError.contractId).toBe('TEST-01');
    expect(tipError.templateField).toBe('contextDescription');
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-interp-03 — Variable manquante dans extractionPrompt → TemplateInterpolationError', async () => {
    const contract = {
      ...simpleContract,
      extractionPrompt: 'Process {{missing_reason}}',
    };

    const error = await extractor
      .extract('anything', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemplateInterpolationError);
    expect((error as TemplateInterpolationError).templateField).toBe(
      'extractionPrompt',
    );
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('tv-interp-04 — Variables excédentaires ignorées silencieusement', async () => {
    llmClient = mockLLMClient('{"name":"B","age":2}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription: 'Just {{agent_response}}',
    };

    await extractor.extract('hello', contract, {
      extra_key: 'unused',
      another: 'also unused',
    });

    expect(llmClient.complete).toHaveBeenCalledWith(
      'Just hello',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('tv-interp-05 — Espaces dans accolades ≠ placeholder', async () => {
    llmClient = mockLLMClient('{"name":"C","age":3}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription: 'Keep {{ spaces }} and {{agent_response}}',
    };

    await extractor.extract('hi', contract, {});

    expect(llmClient.complete).toHaveBeenCalledWith(
      'Keep {{ spaces }} and hi',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('tv-interp-06 — [NORMATIF] Interpolation avec $ dans agentResponse', async () => {
    llmClient = mockLLMClient('{"name":"D","age":4}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription: 'Response: {{agent_response}}',
    };

    await extractor.extract(
      'Price: $100 (regex: $1 back-ref $& match)',
      contract,
      {},
    );

    expect(llmClient.complete).toHaveBeenCalledWith(
      'Response: Price: $100 (regex: $1 back-ref $& match)',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('tv-interp-07 — Placeholders multiples dans un même template', async () => {
    llmClient = mockLLMClient('{"name":"E","age":5}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription:
        '{{reason}} at lines {{start_line}}-{{end_line}}: {{agent_response}}',
    };

    await extractor.extract('found unclosed fence', contract, {
      reason: 'UNCLOSED_FENCE',
      start_line: '10',
      end_line: '20',
    });

    expect(llmClient.complete).toHaveBeenCalledWith(
      'UNCLOSED_FENCE at lines 10-20: found unclosed fence',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('tv-interp-08 — Template vide = string vide, pas erreur', async () => {
    llmClient = mockLLMClient('{"name":"F","age":6}');
    extractor = new StructuredExtractor(llmClient);
    const contract = {
      ...simpleContract,
      contextDescription: '',
      extractionPrompt: '',
    };

    await extractor.extract('anything', contract, {});

    expect(llmClient.complete).toHaveBeenCalledWith(
      '',
      '',
      expect.any(Object),
    );
  });

  it('tv-interp-09 — contextDescription interpolée AVANT extractionPrompt (ordre verrouillé)', async () => {
    const contract = {
      ...simpleContract,
      contextDescription: 'Hello {{ctx_only_var}}',
      extractionPrompt: 'Process {{prompt_only_var}}',
    };

    const error = await extractor
      .extract('anything', contract, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemplateInterpolationError);
    const tipError = error as TemplateInterpolationError;
    expect(tipError.variableName).toBe('ctx_only_var');
    expect(tipError.templateField).toBe('contextDescription');
    expect(llmClient.complete).not.toHaveBeenCalled();
  });
});
