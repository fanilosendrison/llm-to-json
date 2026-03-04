import { describe, it, expect } from 'vitest';
import { interpolate } from '../src/interpolate';
import { TemplateInterpolationError } from '../src/errors';

describe('interpolate() — unit tests', () => {
  it('replaces a single placeholder', () => {
    const result = interpolate(
      'Hello {{name}}',
      { name: 'World' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('Hello World');
  });

  it('replaces multiple placeholders', () => {
    const result = interpolate(
      '{{reason}} at {{start_line}}-{{end_line}}',
      { reason: 'UNCLOSED_FENCE', start_line: '10', end_line: '20' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('UNCLOSED_FENCE at 10-20');
  });

  it('throws TemplateInterpolationError on missing variable', () => {
    expect(() =>
      interpolate(
        'Hello {{unknown}}',
        {},
        'C-TEST',
        'contextDescription',
      ),
    ).toThrow(TemplateInterpolationError);

    try {
      interpolate('Hello {{unknown}}', {}, 'C-TEST', 'extractionPrompt');
    } catch (e) {
      const err = e as TemplateInterpolationError;
      expect(err.variableName).toBe('unknown');
      expect(err.contractId).toBe('C-TEST');
      expect(err.templateField).toBe('extractionPrompt');
      expect(err.message).toBe(
        "Missing variable 'unknown' in extractionPrompt of contract C-TEST",
      );
    }
  });

  it('ignores excess variables silently', () => {
    const result = interpolate(
      'Just {{used}}',
      { used: 'yes', extra: 'ignored', another: 'also ignored' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('Just yes');
  });

  it('leaves {{ spaces }} as-is (not a placeholder)', () => {
    const result = interpolate(
      'Keep {{ spaces }} and {{valid}}',
      { valid: 'OK' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('Keep {{ spaces }} and OK');
  });

  it('[NORMATIF] preserves $ characters literally in values', () => {
    const value = 'Price: $100 (regex: $1 back-ref $& match)';
    const result = interpolate(
      'Response: {{agent_response}}',
      { agent_response: value },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe(
      'Response: Price: $100 (regex: $1 back-ref $& match)',
    );
  });

  it('returns empty string for empty template', () => {
    const result = interpolate('', { any: 'var' }, 'C-TEST', 'contextDescription');
    expect(result).toBe('');
  });

  it('returns template unchanged when no placeholders present', () => {
    const result = interpolate(
      'No placeholders here',
      {},
      'C-TEST',
      'extractionPrompt',
    );
    expect(result).toBe('No placeholders here');
  });

  it('handles adjacent placeholders', () => {
    const result = interpolate(
      '{{a}}{{b}}',
      { a: 'hello', b: 'world' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('helloworld');
  });

  it('handles same placeholder used multiple times', () => {
    const result = interpolate(
      '{{x}} and {{x}} again',
      { x: 'val' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('val and val again');
  });

  it('throws on first missing variable encountered', () => {
    try {
      interpolate(
        '{{exists}} then {{missing1}} and {{missing2}}',
        { exists: 'ok' },
        'C-TEST',
        'contextDescription',
      );
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as TemplateInterpolationError;
      expect(err.variableName).toBe('missing1');
    }
  });

  it('handles underscores and numbers in variable names', () => {
    const result = interpolate(
      '{{_private}} {{var2}} {{a_b_c3}}',
      { _private: 'A', var2: 'B', a_b_c3: 'C' },
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('A B C');
  });

  it('does not match names starting with a digit', () => {
    // {{3bad}} should NOT be treated as a placeholder
    const result = interpolate(
      'Keep {{3bad}} as-is',
      {},
      'C-TEST',
      'contextDescription',
    );
    expect(result).toBe('Keep {{3bad}} as-is');
  });
});
