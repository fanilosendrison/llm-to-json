---
id: SPEC-BRIEF-LLM-TO-JSON-VECTOR-TESTS-LIST-V5
version: "0.1.0"
scope: Brief TDD — test vectors pour StructuredExtractor (interpolation, extract flow, errors, schema, logging, ajv, edge cases)
status: draft
validates: [tests/*.ts]
---

# llm-to-json — Brief Test Vectors v5

## PHASE 1 — Create RED Test Suite Only (No Implementation)

### ✅ Goal

You must **ONLY** create a full **TDD test suite** for the `llm-to-json` package (`StructuredExtractor`).

Do **NOT** implement the package.

Stop after you have run the test suite and confirmed: **all tests are RED**.

**Tech stack (mandatory):**

- Language: TypeScript
- Test runner: Vitest
- All tests must be in `.test.ts` files

### Why

We want a deterministic extraction foundation for SN-Engine and Markdown Structural Normalizer. Tests lock:

- interpolation correctness (function replacement, `$` safety, placeholder regex)
- extract() 10-step flow wiring (clone, inject, interpolate, call, parse, validate, return)
- error taxonomy (3 `ExtractionFatalError` types + `TypeError` + `TemplateInterpolationError`)
- schema dynamic lifecycle (`removeSchema` in `finally`, reference identity)
- logging contract (JSON one-line, pairing `extract_start`/`extract_end`, `errorType` mapping)
- Ajv configuration (no coercion, no defaults, strict mode, fail-fast)
- statelessness and idempotence between calls

---

## ✅ TARGET API (WHAT TO TEST)

Assume a class:

- `new StructuredExtractor(llmClient: LLMClient)`
- `extractor.extract<T>(agentResponse: string, contract: ExtractionContract<T>, variables: Record<string, string>): Promise<T>`

> **Single attempt mode**: there is no retry. One call to `extract()` = one call to `llmClient.complete()`. If extraction fails, `ExtractionFatalError` is thrown immediately. If a non-extraction error occurs (TypeError, LLMClient error, schema compilation), it propagates unchanged.

> **No markdown strip**: the package never cleans the LLM response. Raw response goes directly to `JSON.parse()`. If the LLM wraps in ` ```json ``` `, that's `INVALID_JSON`.

### Core types (contractual — from llm-to-json spec v14)

```typescript
interface LLMClient {
  complete(system: string, user: string, config: { temperature: number; maxTokens: number }): Promise<string>;
}

interface ExtractionContract<T> {
  id: string;
  sourceAgent: string;
  contextDescription: string;      // template with {{variables}} → system prompt
  extractionPrompt: string;        // template with {{variables}} → user prompt
  outputSchema: JSONSchema | ((variables: Record<string, string>) => JSONSchema);
  maxTokens?: number;              // default: 1024, must be positive integer
  parse(raw: unknown): T;
}

type ExtractionErrorType = 'INVALID_JSON' | 'SCHEMA_VIOLATION' | 'PARSE_ERROR';

class ExtractionFatalError extends Error {
  type: ExtractionErrorType;
  rawOutput: string;
  contractId: string;
  details?: string;
}

class TemplateInterpolationError extends Error {
  variableName: string;
  contractId: string;
  templateField: 'contextDescription' | 'extractionPrompt';
}
```

### Mock LLMClient (test infrastructure)

```typescript
function mockLLMClient(response: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

function mockLLMClientRejecting(error: Error): LLMClient {
  return {
    complete: vi.fn().mockRejectedValue(error),
  };
}
```

### Inline test contract (reference — do NOT use real C1–C6)

```typescript
const simpleContract: ExtractionContract<{ name: string; age: number }> = {
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
```

---

## ✅ EXTRACT FLOW (AUTHORITATIVE — from llm-to-json spec v14 §Flux interne)

The `extract()` method MUST execute the following steps in this exact order:

0. **Log `extract_start`** — `console.error(JSON.stringify({ event: 'extract_start', contractId, sourceAgent, timestamp }))` — before any validation
1. **Validate agentResponse** — empty or whitespace-only → `TypeError('agentResponse must be a non-empty string')`
2. **Clone variables** — `variables = { ...variables }`, then inject `variables["agent_response"] = agentResponse`
3. **Validate maxTokens** — if defined and (non-integer or ≤ 0) → `TypeError('maxTokens must be a positive integer')`
4. **Interpolate** — `system = interpolate(contextDescription, variables)`, `user = interpolate(extractionPrompt, variables)`
5. **Resolve schema** — if function → `isDynamic = true`, call it with variables post-injection; if object → `isDynamic = false`
6. **Call LLM** — `llmClient.complete(system, user, { temperature: 0, maxTokens: contract.maxTokens ?? 1024 })`
7. **JSON.parse** — failure → `ExtractionFatalError('INVALID_JSON', rawResponse, contractId, message)`
8. **Ajv validate** — failure → `ExtractionFatalError('SCHEMA_VIOLATION', rawResponse, contractId, ajvErrors)`. If `isDynamic`, `ajv.removeSchema(resolvedSchema)` in `finally` wrapping steps 8–9 (post-compile only).
9. **contract.parse(parsed)** — failure → `ExtractionFatalError('PARSE_ERROR', rawResponse, contractId, extractMessage(error))`
10. **Return T** — log `extract_end` with `success: true`

On any error: log `extract_end` with `success: false` and `errorType`, then re-throw unchanged.

Notes:

- Steps 1–10 are wrapped in try/catch **for logging only** — errors are never wrapped or absorbed.
- `temperature: 0` is fixed — extraction must be maximally deterministic.
- `agent_response` is always injected into the clone, overwriting any caller-provided value.
- `removeSchema` scope: post-compile `finally` only. Never called if JSON.parse fails (step 7) because schema was never compiled.

---

## ✅ INTERPOLATION RULES (AUTHORITATIVE — from llm-to-json spec v14 §Interpolation)

- Pattern: `PLACEHOLDER_REGEX = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g`
- `{{ x }}` (with spaces) is NOT a placeholder — left as-is, no error.
- Missing variable in dict → `TemplateInterpolationError` with `variableName`, `contractId`, `templateField`.
- Excess variables in dict → silently ignored.
- **Normative**: must use **function replacement** (`replace(regex, (_, name) => variables[name])`), not string replacement. String replacement interprets `$1`, `$&`, `$$` in replacement values.
- Empty template → empty string, no error.

---

## ✅ AJV CONFIGURATION (AUTHORITATIVE — from llm-to-json spec v14 §Validation schema)

| Option | Value | Rationale |
|---|---|---|
| Draft | JSON Schema draft-07 | Sufficient for all C1–C6 contracts |
| `allErrors` | `false` | Fail-fast |
| `coerceTypes` | `false` | LLM must produce correct types |
| `useDefaults` | `false` | No mutation — `parse()` gets raw `JSON.parse()` output |
| `strict` | `true` | Detect schema bugs at compile time |

Single Ajv instance created in constructor, reused across calls. Dynamic schemas cleaned up via `removeSchema(resolvedSchema)` in `finally` (same object reference, no `$id`).

---

## ✅ LOGGING CONTRACT (AUTHORITATIVE — from llm-to-json spec v14 §Logging)

- Format: `console.error(JSON.stringify({ ... }))` — one string argument, parseable JSON.
- `extract_start`: emitted **before** any validation (step 0). Fields: `event`, `contractId`, `sourceAgent`, `timestamp` (ISO 8601).
- `extract_end`: emitted after return or catch. Fields: `event`, `contractId`, `sourceAgent`, `success` (boolean), `errorType` (on failure), `timestamp`.
- `errorType` mapping: `error.type` for `ExtractionFatalError`, `error.name` for all others (`'TypeError'`, `'TemplateInterpolationError'`, etc.). If no `name`, use `'unknown'`.
- Key order in JSON is not normative — tests must parse and check values.
- Pairing guarantee: every `extract_start` has a matching `extract_end`, even if step 1 throws.

---

## ✅ ERROR TAXONOMY (AUTHORITATIVE — from llm-to-json spec v14 §Erreurs)

### Extraction errors (wrapped by package)

| Error class | Type field | Triggered at | Details source |
|---|---|---|---|
| `ExtractionFatalError` | `INVALID_JSON` | Step 7 | `JSON.parse` error message |
| `ExtractionFatalError` | `SCHEMA_VIOLATION` | Step 8 | `ajv.errorsText()` |
| `ExtractionFatalError` | `PARSE_ERROR` | Step 9 | `extractMessage(error)` — `error instanceof Error ? error.message : String(error)` |

### Non-extraction errors (propagated unchanged)

| Source | Error type | Triggered at |
|---|---|---|
| `agentResponse` empty/whitespace | `TypeError` | Step 1 |
| `maxTokens` invalid | `TypeError` | Step 3 |
| `LLMClient.complete()` | Provider-dependent | Step 6 |
| `outputSchema(variables)` throws | Consumer-dependent | Step 5 |
| Ajv schema compilation | Ajv `Error` | Step 8 (pre-validate) |

> **Normative rule**: the package NEVER wraps non-extraction errors. They propagate to the caller identical to their original form.

---

## 📑 TEST VECTOR FORMAT

Test vectors are **inline** (no fixture directories). Each vector specifies:

- **Contract override** (fields that differ from `simpleContract`)
- **agentResponse** (first argument to `extract()`)
- **Variables** (third argument to `extract()`)
- **LLM mock response** (what `complete()` returns)
- **Assertions** (result value, error type/fields, spy expectations)

### Test infrastructure (every test file)

```typescript
// tests/helpers.ts — shared across all test files
import { vi } from 'vitest';
import type { LLMClient } from '../src/llm-client';
import type { ExtractionContract } from '../src/contract';
import type { JSONSchema } from '../src/schema';

export function mockLLMClient(response: string): LLMClient {
  return { complete: vi.fn().mockResolvedValue(response) };
}

export function mockLLMClientRejecting(error: Error): LLMClient {
  return { complete: vi.fn().mockRejectedValue(error) };
}

export const simpleContract: ExtractionContract<{ name: string; age: number }> = {
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
  parse(raw) { return raw as { name: string; age: number }; },
};
```

```typescript
// In each .test.ts file:
import { mockLLMClient, mockLLMClientRejecting, simpleContract } from './helpers';
import { StructuredExtractor } from '../src/index';
import type { LLMClient } from '../src/llm-client';

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
```

Each test overrides `llmClient` mock response as needed. Tests that need a rejecting client create their own `mockLLMClientRejecting()`.

Naming convention: `tv-{family}-{nn}` where family is `interp` (interpolation), `flow` (extract wiring), `err` (error paths), `schema` (dynamic schema), `log` (logging), `ajv` (Ajv config), `edge` (edge cases).

---

## ✅ PROJECT SCAFFOLDING (MANDATORY BEFORE TESTS)

Create the following project structure before writing any test:

```
llm-to-json/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts              # re-exports (stubs in red phase)
│   ├── extractor.ts          # StructuredExtractor stub
│   ├── errors.ts             # ExtractionFatalError, TemplateInterpolationError stubs
│   ├── contract.ts           # ExtractionContract<T> type
│   ├── llm-client.ts         # LLMClient type
│   └── schema.ts             # JSONSchema type re-export
└── tests/
    ├── helpers.ts                   # shared: mockLLMClient, mockLLMClientRejecting, simpleContract
    ├── interpolation.test.ts       # tv-interp-01..09
    ├── extract-flow.test.ts        # tv-flow-01..12
    ├── errors.test.ts              # tv-err-01..16b
    ├── schema-dispatch.test.ts     # tv-schema-01..04 (real Ajv, NO mock)
    ├── schema-lifecycle.test.ts    # tv-schema-05..10 (mocked Ajv for removeSchema spying)
    ├── logging.test.ts             # tv-log-01..09
    ├── ajv-config.test.ts          # tv-ajv-01..04
    └── edge-cases.test.ts          # tv-edge-01..04
```

> **File organization**: one test file per family. This is mandatory — do NOT merge families into a single file. Each file maps to one `describe()` block.

### package.json (minimal)

```json
{
  "name": "@yada-one/llm-to-json",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ajv": "^8.17.1"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

> **Critical**: `ajv` is a **runtime dependency** (not devDependency). The package uses it at extraction time, not just in tests.

### tsconfig.json (minimal)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

---

## ✅ TYPE STUBS (RED PHASE — compile but fail at runtime)

Create minimal stubs in `src/` that export the correct symbols with **throwing implementations**. Tests must **compile** but **fail at runtime** (red), not at compile time.

### src/schema.ts

```typescript
import type { SchemaObject } from 'ajv';
export type JSONSchema = SchemaObject;
```

### src/llm-client.ts

```typescript
export interface LLMClient {
  complete(system: string, user: string, config: { temperature: number; maxTokens: number }): Promise<string>;
}
```

### src/contract.ts

```typescript
import type { JSONSchema } from './schema';

export interface ExtractionContract<T> {
  id: string;
  sourceAgent: string;
  contextDescription: string;
  extractionPrompt: string;
  outputSchema: JSONSchema | ((variables: Record<string, string>) => JSONSchema);
  maxTokens?: number;
  parse(raw: unknown): T;
}
```

### src/errors.ts

```typescript
export type ExtractionErrorType = 'INVALID_JSON' | 'SCHEMA_VIOLATION' | 'PARSE_ERROR';

export class ExtractionFatalError extends Error {
  type: ExtractionErrorType;
  rawOutput: string;
  contractId: string;
  details?: string;

  constructor(type: ExtractionErrorType, rawOutput: string, contractId: string, details?: string) {
    super(`Extraction failed [${type}] for contract ${contractId}${details ? `: ${details}` : ''}`);
    this.name = 'ExtractionFatalError';
    this.type = type;
    this.rawOutput = rawOutput;
    this.contractId = contractId;
    this.details = details;
  }
}

export class TemplateInterpolationError extends Error {
  variableName: string;
  contractId: string;
  templateField: 'contextDescription' | 'extractionPrompt';

  constructor(variableName: string, contractId: string, templateField: 'contextDescription' | 'extractionPrompt') {
    super(`Missing variable '${variableName}' in ${templateField} of contract ${contractId}`);
    this.name = 'TemplateInterpolationError';
    this.variableName = variableName;
    this.contractId = contractId;
    this.templateField = templateField;
  }
}
```

> **Note**: the error classes are fully implemented in stubs — they are pure data containers with no logic to test. This is intentional. The tests target `StructuredExtractor.extract()`, not the error constructors.

### src/extractor.ts

```typescript
import type { LLMClient } from './llm-client';
import type { ExtractionContract } from './contract';

export class StructuredExtractor {
  constructor(_llmClient: LLMClient) {}

  async extract<T>(
    _agentResponse: string,
    _contract: ExtractionContract<T>,
    _variables: Record<string, string>
  ): Promise<T> {
    throw new Error('Not implemented');
  }
}
```

### src/index.ts

```typescript
export { StructuredExtractor } from './extractor';
export type { ExtractionContract } from './contract';
export type { LLMClient } from './llm-client';
export type { ExtractionErrorType } from './errors';
export type { JSONSchema } from './schema';
export { ExtractionFatalError } from './errors';
export { TemplateInterpolationError } from './errors';
```

> **Normative**: these are the **exact** public exports of the package. Nothing else is exported. Tests import from `../src/index` (or from individual files for internal access if needed).

---

## ✅ AJV MOCK STRATEGY (for tv-schema-05..10)

The `StructuredExtractor` creates its Ajv instance internally. To spy on `removeSchema`, tests MUST mock the `ajv` module at the module level.

> **File split**: tv-schema-01..04 (dispatch tests) live in `schema-dispatch.test.ts` which uses the **real Ajv**. tv-schema-05..10 (lifecycle tests) live in `schema-lifecycle.test.ts` which **mocks Ajv**. Do NOT merge these files — the mock would break dispatch tests.

### Recommended pattern

```typescript
// tests/schema-lifecycle.test.ts

import { vi, describe, it, expect, beforeEach } from 'vitest';

// --- Ajv mock setup ---
const removeSchemaSpy = vi.fn();
const compileSpy = vi.fn();
const errorsTextSpy = vi.fn(() => 'mock error');

// Track the last compiled schema reference for identity assertion
let lastCompiledSchemaRef: unknown = null;

vi.mock('ajv', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      compile: compileSpy.mockImplementation((schema: unknown) => {
        lastCompiledSchemaRef = schema;
        // Return a validate function that succeeds by default
        const validate = vi.fn(() => true) as any;
        validate.errors = null;
        return validate;
      }),
      removeSchema: removeSchemaSpy,
      errorsText: errorsTextSpy,
    })),
  };
});

// Import AFTER mock setup (Vitest hoists vi.mock, but be explicit)
import { StructuredExtractor } from '../src/extractor';
// ... other imports
```

### How to assert reference identity (tv-schema-05)

```typescript
it('removeSchema called with same object reference', async () => {
  const schemaObj = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const outputSchemaFn = vi.fn(() => schemaObj);

  const contract = {
    ...simpleContract,
    outputSchema: outputSchemaFn,
  };

  await extractor.extract('valid', contract, {});

  // The reference passed to removeSchema must be the SAME object returned by outputSchema()
  expect(removeSchemaSpy).toHaveBeenCalledOnce();
  expect(removeSchemaSpy).toHaveBeenCalledWith(schemaObj);
  // Bonus: verify it's the same reference, not a copy
  expect(removeSchemaSpy.mock.calls[0][0]).toBe(schemaObj);
});
```

### How to make validation fail (tv-schema-07)

```typescript
it('removeSchema called even on SCHEMA_VIOLATION', async () => {
  // Override compile to return a failing validate function
  compileSpy.mockImplementationOnce((schema: unknown) => {
    lastCompiledSchemaRef = schema;
    const validate = vi.fn(() => false) as any;
    validate.errors = [{ message: 'mock violation' }];
    return validate;
  });

  const contract = {
    ...simpleContract,
    outputSchema: vi.fn(() => ({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false })),
  };

  await expect(extractor.extract('valid', contract, {}))
    .rejects.toThrow(ExtractionFatalError);

  expect(removeSchemaSpy).toHaveBeenCalledOnce();
});
```

### Important constraints

- **Reset spies in `beforeEach`**: `removeSchemaSpy.mockClear()`, `compileSpy.mockClear()`, `lastCompiledSchemaRef = null`. This prevents cross-contamination between tests.
- **Non-schema tests in other files are unaffected**: the `vi.mock('ajv')` is file-scoped. Tests in `extract-flow.test.ts`, `errors.test.ts`, and `schema-dispatch.test.ts` use the real Ajv.
- **tv-schema-08 (INVALID_JSON + dynamic schema)**: `compile` should NOT be called because JSON.parse fails at step 7, before `ajv.compile` at step 8. Assert `compileSpy` not called AND `removeSchemaSpy` not called. Note that the `outputSchema` function IS still called at step 5 (schema resolution) — only compilation is skipped.
- **tv-schema-06 (static schema)**: `removeSchemaSpy` must NOT be called. The static schema path skips `removeSchema` entirely.
- **tv-schema-10 (dynamic schema + compile error)**: `compileSpy` IS called once (and throws). `removeSchemaSpy` must NOT be called — the `finally` starts after `compile()`, so if `compile()` throws, the `finally` is never entered. To make compile throw in the mock, use `compileSpy.mockImplementationOnce(() => { throw new Error('schema is invalid'); })`. The `outputSchema` function IS still called at step 5.

> **Alternative approach**: if mocking Ajv at module level causes issues, tests may instead access the Ajv instance via `(extractor as any)._ajv` or similar private access. This is acceptable in tests only — the production API must not expose Ajv. Choose whichever approach compiles cleanly. Only `schema-lifecycle.test.ts` mocks Ajv.

---

# ✅ TEST VECTORS (COMPLETE)

## 1 — Interpolation — 9 vectors

---

### tv-interp-01 — Happy path, remplacement simple

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'Agent {{agent_name}} said: {{agent_response}}'` |
| agentResponse | `'The answer is 42'` |
| Variables | `{ agent_name: 'Worker1' }` |
| LLM mock response | `'{"name":"A","age":1}'` |

#### Test assertions

- spy `complete` called with arg1 = `'Agent Worker1 said: The answer is 42'`.

---

### tv-interp-02 — Variable manquante dans contextDescription → TemplateInterpolationError

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'Hello {{unknown_var}}'` |
| agentResponse | `'anything'` |
| Variables | `{}` |

#### Test assertions

- throws `TemplateInterpolationError`.
- error has `variableName: 'unknown_var'`, `contractId: 'TEST-01'`, `templateField: 'contextDescription'`.
- spy `complete` NOT called (interpolation fails at step 4, before LLM call).

---

### tv-interp-03 — Variable manquante dans extractionPrompt → TemplateInterpolationError

#### Setup

| Field | Value |
|---|---|
| Contract override | `extractionPrompt: 'Process {{missing_reason}}'` |
| agentResponse | `'anything'` |
| Variables | `{}` |

#### Test assertions

- throws `TemplateInterpolationError`.
- error has `templateField: 'extractionPrompt'`.
- spy `complete` NOT called.

---

### tv-interp-04 — Variables excédentaires ignorées silencieusement

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'Just {{agent_response}}'` |
| agentResponse | `'hello'` |
| Variables | `{ extra_key: 'unused', another: 'also unused' }` |
| LLM mock response | `'{"name":"B","age":2}'` |

#### Test assertions

- no error thrown.
- spy `complete` called with arg1 = `'Just hello'`.

---

### tv-interp-05 — Espaces dans accolades ≠ placeholder

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'Keep {{ spaces }} and {{agent_response}}'` |
| agentResponse | `'hi'` |
| Variables | `{}` |
| LLM mock response | `'{"name":"C","age":3}'` |

#### Test assertions

- spy `complete` called with arg1 = `'Keep {{ spaces }} and hi'`.
- `{{ spaces }}` left as-is in output — no error.

---

### tv-interp-06 — [NORMATIF] Interpolation avec `$` dans agentResponse

> **Anti-cheat**: bloque `String.replace(regex, string)` qui interpréterait `$1`, `$&` comme captures regex.

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'Response: {{agent_response}}'` |
| agentResponse | `'Price: $100 (regex: $1 back-ref $& match)'` |
| Variables | `{}` |
| LLM mock response | `'{"name":"D","age":4}'` |

#### Test assertions

- spy `complete` called with arg1 = `'Response: Price: $100 (regex: $1 back-ref $& match)'`.
- `$100`, `$1`, `$&` preserved **literally** — not interpreted as regex replacement patterns.

---

### tv-interp-07 — Placeholders multiples dans un même template

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: '{{reason}} at lines {{start_line}}-{{end_line}}: {{agent_response}}'` |
| agentResponse | `'found unclosed fence'` |
| Variables | `{ reason: 'UNCLOSED_FENCE', start_line: '10', end_line: '20' }` |
| LLM mock response | `'{"name":"E","age":5}'` |

#### Test assertions

- spy `complete` called with arg1 = `'UNCLOSED_FENCE at lines 10-20: found unclosed fence'`.

---

### tv-interp-08 — Template vide = string vide, pas d'erreur

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: '', extractionPrompt: ''` |
| agentResponse | `'anything'` |
| Variables | `{}` |
| LLM mock response | `'{"name":"F","age":6}'` |

#### Test assertions

- spy `complete` called with arg1 = `''` (system), arg2 = `''` (user).
- no error.

---

### tv-interp-09 — contextDescription interpolée AVANT extractionPrompt (ordre verrouillé)

> Locks the interpolation order defined in step 4 of extract flow. Without this test, an implementation could interpolate extractionPrompt first and all other tests would still pass.

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'Hello {{ctx_only_var}}', extractionPrompt: 'Process {{prompt_only_var}}'` |
| agentResponse | `'anything'` |
| Variables | `{}` (neither `ctx_only_var` nor `prompt_only_var` present) |

#### Test assertions

- throws `TemplateInterpolationError`.
- error has `variableName: 'ctx_only_var'`, `templateField: 'contextDescription'`.
- error does NOT have `variableName: 'prompt_only_var'` — contextDescription fails first, extractionPrompt is never reached.
- spy `complete` NOT called.

---

## 2 — Flux extract() wiring & happy path — 12 vectors

---

### tv-flow-01 — Happy path complet (JSON valide, schema OK, parse OK → T)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"Alice","age":30}'` |
| Contract | `simpleContract` |
| agentResponse | `'raw input'` |
| Variables | `{}` |

#### Test assertions

- `extract()` returns `{ name: 'Alice', age: 30 }`.

---

### tv-flow-02 — `complete` reçoit system interpolé, user interpolé, config correcte

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: 'System: {{agent_response}}', extractionPrompt: 'User: {{agent_response}}', maxTokens: 2048` |
| agentResponse | `'test input'` |
| Variables | `{}` |
| LLM mock response | `'{"name":"Bob","age":25}'` |

#### Test assertions

- spy `complete` called once.
- arg1 = `'System: test input'`, arg2 = `'User: test input'`, arg3 = `{ temperature: 0, maxTokens: 2048 }`.

---

### tv-flow-03 — [NORMATIF] `temperature: 0` fixe dans l'appel LLM

> **Anti-cheat**: bloque le hardcoding d'une température différente.

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"C","age":1}'` |
| Contract | `simpleContract` |
| agentResponse | `'valid'` |

#### Test assertions

- spy `complete`: third argument contains `temperature: 0`.

---

### tv-flow-04 — maxTokens par défaut = 1024

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"D","age":2}'` |
| Contract | `simpleContract` (no `maxTokens` defined) |
| agentResponse | `'valid'` |

#### Test assertions

- spy `complete`: third argument contains `maxTokens: 1024`.

---

### tv-flow-05 — Clone défensif (dictionnaire original non muté)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"E","age":3}'` |
| agentResponse | `'input'` |
| Variables | `const vars = { myKey: 'myValue' }` |

#### Test assertions

- after `extract()` returns, `vars` is still `{ myKey: 'myValue' }`.
- no `agent_response` key added to original dict.

---

### tv-flow-06 — Injection automatique de `agent_response`

#### Setup

| Field | Value |
|---|---|
| Contract override | `extractionPrompt: 'Analyze: {{agent_response}}'` |
| agentResponse | `'This is the raw response'` |
| Variables | `{}` (no manual `agent_response`) |
| LLM mock response | `'{"name":"F","age":4}'` |

#### Test assertions

- spy `complete`: arg2 contains `'Analyze: This is the raw response'`.

---

### tv-flow-07 — `agent_response` fourni par l'appelant est écrasé

#### Setup

| Field | Value |
|---|---|
| Contract override | `extractionPrompt: '{{agent_response}}'` |
| agentResponse | `'real response'` |
| Variables | `{ agent_response: 'should be overwritten' }` |
| LLM mock response | `'{"name":"G","age":5}'` |

#### Test assertions

- spy `complete`: arg2 = `'real response'` (not `'should be overwritten'`).

---

### tv-flow-08 — `parse()` reçoit le retour brut de `JSON.parse` (non transformé)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"H","age":6}'` |
| Contract | `{ ...simpleContract, parse: vi.fn((raw) => raw) }` |
| agentResponse | `'valid'` |

#### Test assertions

- `parse` spy called with exactly `{ name: 'H', age: 6 }` (raw `JSON.parse` output, no Ajv mutation).
- **Identity check**: the object passed to `parse` must be the **same reference** as the `JSON.parse` return value — not a deep clone. Assertion: `expect(parseSpy.mock.calls[0][0]).toBe(result)` where `result` is the return of `extract()` (since `parse` returns `raw` as-is, the reference chain is `JSON.parse → validate (no mutation) → parse(raw) → return raw`).

---

### tv-flow-09 — Retour de `parse()` est le résultat final de `extract()`

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"I","age":7}'` |
| Contract | `{ ...simpleContract, parse: () => ({ transformed: true }) }` |
| agentResponse | `'valid'` |

#### Test assertions

- `extract()` returns exactly `{ transformed: true }`.

---

### tv-flow-10 — Ordre des validations : agentResponse (step 1) avant maxTokens (step 3)

> Locks the validation order. Without this test, an implementation could check maxTokens before agentResponse and all other error tests would still pass.

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: 3.5` (invalid — would cause TypeError at step 3) |
| agentResponse | `''` (invalid — would cause TypeError at step 1) |

#### Test assertions

- throws `TypeError`.
- message = `'agentResponse must be a non-empty string'` (NOT `'maxTokens must be a positive integer'`).
- step 1 fires first, step 3 is never reached.
- spy `complete` NOT called.

---

### tv-flow-11 — Ordre : interpolation (step 4) avant schema resolution (step 5)

> Locks the step 4→step 5 ordering. Without this test, an implementation could resolve the schema before interpolating templates and all other tests would still pass. Same design pattern as tv-flow-10 (two failures on the same call, verify which one wins).

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: '{{missing_var}}', outputSchema: () => { throw new Error('should not reach schema resolution'); }` |
| agentResponse | `'valid'` |
| Variables | `{}` (`missing_var` not present) |

#### Test assertions

- throws `TemplateInterpolationError` with `variableName: 'missing_var'`.
- error is NOT `Error('should not reach schema resolution')` — interpolation fails at step 4, schema resolution (step 5) is never reached.
- spy `complete` NOT called.

---

### tv-flow-12 — Ordre : maxTokens (step 3) avant interpolation (step 4)

> Locks the step 3→4 ordering. Without this test, an implementation could interpolate before validating maxTokens and all other tests would still pass. Completes the ordering chain: tv-flow-10 (1→3), tv-flow-12 (3→4), tv-flow-11 (4→5).

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: -1, contextDescription: '{{missing_var}}'` |
| agentResponse | `'valid'` |
| Variables | `{}` (`missing_var` not present) |

#### Test assertions

- throws `TypeError` with message `'maxTokens must be a positive integer'`.
- error is NOT `TemplateInterpolationError` — maxTokens validation fires at step 3, interpolation (step 4) is never reached.
- spy `complete` NOT called.

---


## 3 — Chemins d'erreur — 17 vectors

---

### tv-err-01 — agentResponse vide → TypeError

#### Setup

| Field | Value |
|---|---|
| agentResponse | `''` |

#### Test assertions

- throws `TypeError` (NOT `ExtractionFatalError`).
- message = `'agentResponse must be a non-empty string'`.
- spy `complete` NOT called (validation fails at step 1, before LLM call).

---

### tv-err-02 — [NORMATIF] agentResponse whitespace-only → TypeError

> **Anti-cheat**: bloque la validation `=== ''` stricte qui laisse passer le whitespace.

#### Setup

| Field | Value |
|---|---|
| agentResponse | `'   \n  '` |

#### Test assertions

- throws `TypeError`.
- message = `'agentResponse must be a non-empty string'`.
- spy `complete` NOT called.

---

### tv-err-03 — maxTokens non-entier → TypeError

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: 3.5` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `TypeError`.
- message = `'maxTokens must be a positive integer'`.
- spy `complete` NOT called (validation fails at step 3, before LLM call).

---

### tv-err-04 — maxTokens = 0 → TypeError

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: 0` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `TypeError`.
- message = `'maxTokens must be a positive integer'`.
- spy `complete` NOT called.

---

### tv-err-05 — maxTokens négatif → TypeError

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: -1` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `TypeError`.
- spy `complete` NOT called.

---

### tv-err-06 — INVALID_JSON (réponse non-JSON)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'This is not JSON at all'` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError`.
- `type: 'INVALID_JSON'`, `rawOutput: 'This is not JSON at all'`, `contractId: 'TEST-01'`.
- `details` contains the `JSON.parse` error message.

---

### tv-err-07 — INVALID_JSON (markdown-wrapped — no strip)

> Confirms normative "no markdown strip" rule.

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `` '```json\n{"name":"A","age":1}\n```' `` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'INVALID_JSON'`.
- the backtick-wrapped JSON is NOT cleaned before `JSON.parse`.

---

### tv-err-08 — SCHEMA_VIOLATION (champ requis manquant)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"B"}'` (missing `age`) |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'SCHEMA_VIOLATION'`, `rawOutput: '{"name":"B"}'`.
- `details` contains Ajv error text.

---

### tv-err-09 — SCHEMA_VIOLATION (type incorrect)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"C","age":"not a number"}'` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'SCHEMA_VIOLATION'`.

---

### tv-err-10 — SCHEMA_VIOLATION (additionalProperties)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"D","age":1,"extra":"field"}'` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'SCHEMA_VIOLATION'`.

---

### tv-err-11 — PARSE_ERROR (parse() throws Error)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"E","age":5}'` |
| Contract | `{ ...simpleContract, parse: () => { throw new Error('count mismatch'); } }` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'PARSE_ERROR'`, `details: 'count mismatch'`, `rawOutput: '{"name":"E","age":5}'`.

---

### tv-err-12 — PARSE_ERROR (parse() throws string)

> Tests `extractMessage` helper: `error instanceof Error ? error.message : String(error)`.

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"F","age":6}'` |
| Contract | `{ ...simpleContract, parse: () => { throw 'raw string error'; } }` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'PARSE_ERROR'`, `details: 'raw string error'`, `rawOutput: '{"name":"F","age":6}'`.

---

### tv-err-13 — PARSE_ERROR (parse() throws number)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"G","age":7}'` |
| Contract | `{ ...simpleContract, parse: () => { throw 42; } }` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'PARSE_ERROR'`, `details: '42'`, `rawOutput: '{"name":"G","age":7}'`.

---

### tv-err-14 — Erreur LLMClient propage telle quelle (pas wrappée)

#### Setup

| Field | Value |
|---|---|
| LLM mock | `mockLLMClientRejecting(new Error('API timeout'))` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `Error` (NOT `ExtractionFatalError`).
- message = `'API timeout'`.
- error instance is the same object the mock rejected with.

---

### tv-err-15 — Erreur outputSchema dynamique propage telle quelle

#### Setup

| Field | Value |
|---|---|
| Contract override | `outputSchema: () => { throw new Error('bad reason'); }` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `Error` with message `'bad reason'`.
- NOT wrapped in `ExtractionFatalError`.
- spy `complete` NOT called (schema resolution is step 5, before LLM call at step 6).

---

### tv-err-16a — maxTokens null → TypeError

> In pure JS (or via `as any`), `null` is a "defined" value (`contract.maxTokens !== undefined` is `true` for `null`). An implementer using `contract.maxTokens != null` (loose equality) would skip validation for `null` — this test blocks that shortcut.

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: null as any` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `TypeError` with message `'maxTokens must be a positive integer'`.
- spy `complete` NOT called.

---

### tv-err-16b — maxTokens NaN → TypeError

> `NaN` is `typeof 'number'` but `Number.isInteger(NaN)` returns `false`. Tests correct use of `Number.isInteger`.

#### Setup

| Field | Value |
|---|---|
| Contract override | `maxTokens: NaN as any` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `TypeError` with message `'maxTokens must be a positive integer'`.
- spy `complete` NOT called.

---

## 4a — Schema dispatch (real Ajv) — 4 vectors

> **Implementation note**: these tests verify that dynamic schema functions are called correctly and that schema variation works. This test file (`schema-dispatch.test.ts`) MUST NOT mock Ajv — it uses the real `ajv` module.

---

### tv-schema-01 — Fonction appelée avec variables post-injection

#### Setup

| Field | Value |
|---|---|
| Contract override | `outputSchema: vi.fn((vars) => simpleContract.outputSchema as JSONSchema)` |
| agentResponse | `'response text'` |
| Variables | `{ reason: 'UNCLOSED_FENCE' }` |
| LLM mock response | `'{"name":"A","age":1}'` |

#### Test assertions

- `outputSchema` spy called once.
- called with object containing `{ reason: 'UNCLOSED_FENCE', agent_response: 'response text' }`.

---

### tv-schema-02 — Schema varie selon l'input (mode string)

#### Setup

| Field | Value |
|---|---|
| Contract | `{ ...simpleContract, outputSchema: (vars) => vars.mode === 'string' ? stringSchema : integerSchema, parse: (raw) => raw as any }` where `stringSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }` and `integerSchema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }` |
| Variables | `{ mode: 'string' }` |
| LLM mock response | `'{"value":"hello"}'` |
| agentResponse | `'valid'` |

#### Test assertions

- `extract()` succeeds, returns `{ value: 'hello' }`.

---

### tv-schema-03 — Schema varie selon l'input (mode integer)

#### Setup

| Field | Value |
|---|---|
| Contract | same dynamic `outputSchema` as tv-schema-02 |
| Variables | `{ mode: 'integer' }` |
| LLM mock response | `'{"value":42}'` |
| agentResponse | `'valid'` |

#### Test assertions

- `extract()` succeeds, returns `{ value: 42 }`.

---

### tv-schema-04 — Schema dynamique rejette le mauvais type

#### Setup

| Field | Value |
|---|---|
| Contract | same dynamic `outputSchema` as tv-schema-02 |
| Variables | `{ mode: 'integer' }` |
| LLM mock response | `'{"value":"hello"}'` (string instead of integer) |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError` with `type: 'SCHEMA_VIOLATION'`.

---

## 4b — Schema lifecycle (mocked Ajv) — 6 vectors

> **Implementation note**: tv-schema-05 through tv-schema-10 require spying on the internal Ajv instance. This test file (`schema-lifecycle.test.ts`) MUST use `vi.mock('ajv')`. See `✅ AJV MOCK STRATEGY` section above for the required mock pattern.

---

### tv-schema-05 — [NORMATIF] `removeSchema` appelé pour schema dynamique (happy path)

> **Anti-cheat**: bloque l'oubli de `removeSchema` (fuite mémoire silencieuse).

#### Setup

| Field | Value |
|---|---|
| Contract | `outputSchema` = function returning valid schema |
| LLM mock response | JSON valide passant le schema |
| agentResponse | `'valid'` |

#### Test assertions

- spy on Ajv instance: `removeSchema` called **once**.
- called with the **same object reference** as the schema returned by the function.

---

### tv-schema-06 — `removeSchema` PAS appelé pour schema statique

#### Setup

| Field | Value |
|---|---|
| Contract | `simpleContract` (static schema) |
| LLM mock response | `'{"name":"B","age":2}'` |
| agentResponse | `'valid'` |

#### Test assertions

- spy on Ajv: `removeSchema` **never** called.

---

### tv-schema-07 — [NORMATIF] `removeSchema` même en cas de SCHEMA_VIOLATION (schema dynamique)

> **Anti-cheat**: bloque le `removeSchema` dans le happy path uniquement.

#### Setup

| Field | Value |
|---|---|
| Contract | `outputSchema` = function returning strict schema |
| LLM mock response | JSON valide mais échouant la validation |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError('SCHEMA_VIOLATION')`.
- AND spy `removeSchema` called once (via `finally`).

---

### tv-schema-08 — [NORMATIF] `removeSchema` PAS appelé quand JSON.parse échoue (schema dynamique)

> **Anti-cheat**: bloque l'appel de `removeSchema` sur un schema jamais compilé.

#### Setup

| Field | Value |
|---|---|
| Contract | `outputSchema` = function |
| LLM mock response | `'not json'` |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError('INVALID_JSON')`.
- spy `removeSchema` **never** called (schema was never compiled).
- spy `compile` **never** called (JSON.parse fails at step 7, before schema compilation at step 8).

---

### tv-schema-09 — `removeSchema` même en cas de PARSE_ERROR (schema dynamique)

> `finally` wraps steps 8–9, so covers `parse()` failures too.

#### Setup

| Field | Value |
|---|---|
| Contract | `outputSchema` = function, `parse()` throws `new Error('invariant')` |
| LLM mock response | JSON valide passant le schema |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError('PARSE_ERROR')`.
- AND spy `removeSchema` called once.

---

### tv-schema-10 — [NORMATIF] `removeSchema` PAS appelé quand `compile()` throw (schema dynamique)

> **Anti-cheat**: bloque le placement de `ajv.compile()` à l'intérieur du try/finally. La spec exige que le `finally` commence **après** `compile()`. Si `compile()` est dans le try/finally, `removeSchema` est appelé sur un schema jamais compilé — le test doit prouver que ce n'est pas le cas.

#### Setup

| Field | Value |
|---|---|
| Contract | `outputSchema` = function returning `{ type: 'invalid_type_here' }` (malformed schema) |
| LLM mock response | `'{"anything":true}'` |
| agentResponse | `'valid'` |

#### Test assertions

- throws an error (NOT `ExtractionFatalError`) — Ajv compilation error propagates unchanged.
- `compileSpy` called once (and threw).
- `removeSchemaSpy` **never** called — schema was never successfully compiled.

---

## 5 — Logging structuré — 9 vectors

---

### tv-log-01 — [NORMATIF] `extract_start` émis AVANT toute validation

> **Anti-cheat**: bloque le logging de `extract_start` après la validation ou après l'appel LLM. This test uses an agentResponse that fails at step 1 — if `extract_start` were emitted after validation, it would not appear.

#### Setup

| Field | Value |
|---|---|
| agentResponse | `''` (will cause TypeError at step 1) |

#### Test assertions

- `console.error` called exactly 2 times (start + end pairing guaranteed even on earliest possible failure).
- first call: parseable JSON with `{ event: 'extract_start', contractId: 'TEST-01', sourceAgent: 'TestAgent' }` and a `timestamp` field (ISO 8601 string). **Timestamp format check**: `timestamp` must be a string matching ISO 8601 and parseable by `new Date(timestamp)` — assert `!isNaN(new Date(parsed.timestamp).getTime())`.
- second call: parseable JSON with `{ event: 'extract_end', success: false, errorType: 'TypeError' }`.
- then the `TypeError` is re-thrown to the caller.

> **Note**: this vector overlaps with tv-log-04 on the `extract_end` assertion. The distinct purpose of tv-log-01 is to prove that `extract_start` is emitted **before step 1**, not to test the errorType mapping. tv-log-04 exists as a focused errorType test.

---

### tv-log-02 — `extract_end` avec `success: true` (happy path)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"A","age":1}'` |
| agentResponse | `'valid'` |

#### Test assertions

- `console.error` called exactly 2 times.
- second call: JSON with `{ event: 'extract_end', contractId: 'TEST-01', sourceAgent: 'TestAgent', success: true, timestamp: <string> }`.
- **errorType absence**: the parsed JSON must NOT contain an `errorType` key — assert `expect(parsed).not.toHaveProperty('errorType')`. An implementation that always includes `errorType: undefined` or `errorType: null` violates the spec.
- **Timestamp format check**: `timestamp` must be parseable ISO 8601 — assert `!isNaN(new Date(parsed.timestamp).getTime())`.

---

### tv-log-03 — `extract_end` avec `errorType` pour ExtractionFatalError

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'not json'` |
| agentResponse | `'valid'` |

#### Test assertions

- `console.error` called 2 times.
- second call: JSON with `{ event: 'extract_end', contractId: 'TEST-01', sourceAgent: 'TestAgent', success: false, errorType: 'INVALID_JSON' }`.

---

### tv-log-04 — `errorType` = error.name pour TypeError

#### Setup

| Field | Value |
|---|---|
| agentResponse | `''` (TypeError at step 1) |

#### Test assertions

- second `console.error` call: JSON with `{ event: 'extract_end', success: false, errorType: 'TypeError' }`.

---

### tv-log-05 — `errorType` pour TemplateInterpolationError

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: '{{missing}}'` |
| agentResponse | `'valid'` |
| Variables | `{}` |

#### Test assertions

- second `console.error` call: JSON with `{ event: 'extract_end', success: false, errorType: 'TemplateInterpolationError' }`.

---

### tv-log-06 — Format = JSON.stringify (un seul argument string)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"B","age":2}'` |
| agentResponse | `'valid'` |

#### Test assertions

- each `console.error` call receives **exactly one argument** of type `string`.
- each string is parseable by `JSON.parse()`.

---

### tv-log-07 — Pairing garanti (erreur LLMClient → extract_start + extract_end)

#### Setup

| Field | Value |
|---|---|
| LLM mock | `mockLLMClientRejecting(new Error('network'))` |
| agentResponse | `'valid'` |

#### Test assertions

- `console.error` called 2 times.
- first call: `extract_start`.
- second call: `extract_end` with `success: false, errorType: 'Error'` (LLMClient threw a plain `Error`, mapping uses `error.name`).

---

### tv-log-08 — `errorType: 'unknown'` quand l'erreur n'a pas de `name`

> Tests the fallback branch of the errorType mapping: `error.name` for non-`ExtractionFatalError`, `'unknown'` if no `name`. Without this test, an implementer can omit the `'unknown'` fallback and all other tests still pass.

#### Setup

| Field | Value |
|---|---|
| LLM mock | Rejecting with a non-Error object: `mockLLMClient` is not usable here. Create a custom rejecting mock: `{ complete: vi.fn().mockRejectedValue({ message: 'bare object' }) }` — an object with no `name` property and NOT an `instanceof Error`. |
| agentResponse | `'valid'` |

#### Test assertions

- throws (the rejected object propagates unchanged).
- `console.error` called 2 times.
- second call: JSON with `{ event: 'extract_end', success: false, errorType: 'unknown' }`.

> **Assertion guidance for non-Error rejects**: `expect(...).rejects.toThrow()` may not work reliably with non-Error objects. Use a manual try/catch pattern instead:
>
> ```typescript
> const rejectedObj = { message: 'bare object' };
> const client = { complete: vi.fn().mockRejectedValue(rejectedObj) };
> const ext = new StructuredExtractor(client);
> try {
>   await ext.extract('valid', simpleContract, {});
>   expect.fail('should have thrown');
> } catch (error) {
>   expect(error).toBe(rejectedObj); // same reference — propagated unchanged
> }
> // then check consoleSpy as usual
> ```

---

### tv-log-09 — [NORMATIF] `errorType` utilise `instanceof` pas duck-typing

> **Anti-cheat**: bloque l’implémentation simplifiée `error?.type || error?.name || 'unknown'`. Une erreur non-`ExtractionFatalError` ayant une propriété `.type` doit être mappée via `.name`, pas `.type`. Sans ce test, un implémenteur peut utiliser le duck-typing et tous les autres tests passent.

#### Setup

| Field | Value |
|---|---|
| LLM mock | Rejecting with a custom Error subclass: `class APIError extends Error { type = 'RATE_LIMIT'; constructor() { super('rate limited'); this.name = 'APIError'; } }` — create an instance and reject with it: `{ complete: vi.fn().mockRejectedValue(new APIError()) }`. |
| agentResponse | `'valid'` |

#### Test assertions

- throws `APIError` (propagated unchanged).
- `console.error` called 2 times.
- second call: JSON with `{ event: 'extract_end', success: false, errorType: 'APIError' }`.
- errorType is `'APIError'` (from `error.name`), NOT `'RATE_LIMIT'` (from `error.type`).

---

## 6 — Configuration Ajv — 4 vectors

> **Implementation note**: these tests verify real Ajv behavior (coercion, defaults, strict mode). This test file MUST NOT mock Ajv — it uses the real `ajv` module. Only `schema-lifecycle.test.ts` mocks Ajv.

---

### tv-ajv-01 — `coerceTypes: false` (pas de coercion string → number)

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"A","age":"30"}'` (`age` is string, schema expects integer) |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError('SCHEMA_VIOLATION')`.
- Ajv does NOT coerce `"30"` to `30`.

---

### tv-ajv-02 — `useDefaults: false` (pas de mutation par defaults)

#### Setup

| Field | Value |
|---|---|
| Contract | `{ ...simpleContract, outputSchema: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', default: 'user' } }, required: ['name'], additionalProperties: false }, parse: vi.fn((raw) => raw) }` |
| LLM mock response | `'{"name":"B"}'` (`role` absent) |
| agentResponse | `'valid'` |

#### Test assertions

- validation OK (role not required).
- `parse` spy receives `{ name: 'B' }` — `role` field NOT added by Ajv.

---

### tv-ajv-03 — `allErrors: false` (fail-fast)

> The input `'{"wrong":"everything"}'` against `simpleContract` schema violates at least 3 rules (missing `name`, missing `age`, extra `wrong`). With `allErrors: false`, Ajv stops at the first violation. With `allErrors: true`, all 3 would be reported.

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'{"wrong":"everything"}'` (multiple violations) |
| agentResponse | `'valid'` |

#### Test assertions

- throws `ExtractionFatalError('SCHEMA_VIOLATION')`.
- `details` contains **exactly one** Ajv error message (not multiple). This proves `allErrors: false`. Assertion method: `ajv.errorsText()` separates multiple errors with `, ` — verify that `details` does NOT match the pattern `, data` (e.g. `expect(error.details).not.toMatch(/, data/)`). With `allErrors: false` the string is a single error like `"data must have required property 'name'"`.

---

### tv-ajv-04 — Schema malformé → erreur compilation Ajv propage directement

> **Implementation constraint**: the compile error MUST NOT be caught by the same try/catch that wraps validation failure. Compile errors are not extraction failures — they are consumer bugs (malformed schema). If the implementation has a catch around `ajv.compile()` + `validate()` that throws `ExtractionFatalError('SCHEMA_VIOLATION')`, it must re-throw non-`ExtractionFatalError` errors without wrapping.

#### Setup

| Field | Value |
|---|---|
| Contract override | `outputSchema: { type: 'invalid_type_here' }` |
| agentResponse | `'valid'` |
| LLM mock response | `'{"anything":true}'` |

#### Test assertions

- throws an error (NOT `ExtractionFatalError`).
- error from Ajv compilation (`strict: true` detects invalid schema).
- error is NOT `instanceof ExtractionFatalError` — explicit negative check required.

---

## 7 — Edge cases & idempotence — 4 vectors

---

### tv-edge-01 — Instance Ajv réutilisée entre appels

#### Setup

Sequence: two `extract()` calls on the same `StructuredExtractor` instance with the same static contract.

| Field | Value |
|---|---|
| LLM mock response | `'{"name":"A","age":1}'` (both calls) |
| agentResponse | `'valid'` |

#### Test assertions

- both calls succeed.
- no error related to schema already compiled.

---

### tv-edge-02 — StructuredExtractor est stateless entre appels

#### Setup

Sequence: call 1 with contract A (schema `{name, age}`), call 2 with contract B (different schema `{value: string}`). Use `(llmClient.complete as any).mockResolvedValueOnce(response1).mockResolvedValueOnce(response2)` to chain two distinct responses.

| Field | Value |
|---|---|
| Call 1 LLM response | `'{"name":"B","age":2}'` |
| Call 2 LLM response | `'{"value":"hello"}'` |
| Call 2 contract | `{ ...simpleContract, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, parse: (raw) => raw as any }` |
| agentResponse | `'valid'` (both) |

#### Test assertions

- both calls succeed with their respective schemas.
- no state contamination between calls.

---

### tv-edge-03 — ExtractionFatalError expose tous les champs documentés

#### Setup

| Field | Value |
|---|---|
| LLM mock response | `'invalid'` |
| agentResponse | `'valid'` |

#### Test assertions

- caught error is `instanceof ExtractionFatalError`.
- has fields: `type`, `rawOutput`, `contractId`, `details` (all defined).
- inherits from `Error`: has `message`, `name` = `'ExtractionFatalError'`, `stack`.

---

### tv-edge-04 — TemplateInterpolationError expose tous les champs documentés

#### Setup

| Field | Value |
|---|---|
| Contract override | `contextDescription: '{{oops}}'` |
| agentResponse | `'valid'` |
| Variables | `{}` |

#### Test assertions

- caught error has `variableName: 'oops'`, `contractId: 'TEST-01'`, `templateField: 'contextDescription'`.
- `name` = `'TemplateInterpolationError'`.
- inherits from `Error`.

---

# ✅ WHAT TESTS MUST ASSERT

### For every test

- `StructuredExtractor` is instantiated with a mock `LLMClient`.
- `console.error` spy is set via `vi.spyOn(console, 'error')` and reset in `afterEach`.
- Errors are caught and inspected (class, type, fields) — not just "throws".

### For happy path tests

- `extract()` returns the value from `parse()` — nothing more, nothing less.
- spy `complete` called exactly once with correct (system, user, config).

### For error tests

- `ExtractionFatalError` errors have correct `type`, `rawOutput`, `contractId`, `details`.
- `TypeError` errors are NOT `instanceof ExtractionFatalError`.
- Non-extraction errors propagate unchanged (same class, same message, same instance).

### For schema dynamic tests

- **Dispatch tests** (`schema-dispatch.test.ts`): use real Ajv. Verify outputSchema function receives post-injection variables, schema variation works, validation actually runs.
- **Lifecycle tests** (`schema-lifecycle.test.ts`): mock Ajv. Verify `removeSchema` called with same object reference as resolved schema. `removeSchema` NOT called when schema is static. `removeSchema` NOT called when JSON.parse fails (pre-compile). `removeSchema` called in `finally` (covers SCHEMA_VIOLATION and PARSE_ERROR).

### For logging tests

- `console.error` always called with exactly 1 string argument. **Normative**: this assertion (`expect(consoleSpy.mock.calls[n]).toHaveLength(1)` + `expect(typeof consoleSpy.mock.calls[n][0]).toBe('string')`) must be verified in **every** logging test (tv-log-01 through tv-log-09), not only in tv-log-06. An implementation that uses `console.error(JSON.stringify({...}), 'extra')` on error paths must be caught.
- Argument is parseable JSON.
- `extract_start` always precedes any validation.
- `extract_end` always follows, with correct `success` and `errorType`.
- Tests parse the JSON and check values — never compare raw strings (key order not normative).
- `timestamp` fields must be parseable ISO 8601 strings — assert `!isNaN(new Date(parsed.timestamp).getTime())`.

---

# ✅ MINI ANTI-CHEAT TESTS (NORMATIVE)

These tests are identified with `[NORMATIF]` in their vector. They exist to prevent silent implementation shortcuts. Their absence is a **violation of the spec**.

| ID | Anti-cheat vector | What it blocks |
|---|---|---|
| tv-interp-06 | `$` in agentResponse preserved literally | `String.replace(regex, string)` instead of function replacement |
| tv-flow-03 | `temperature: 0` in LLM call | Hardcoded wrong temperature |
| tv-err-02 | whitespace-only agentResponse → TypeError | `=== ''` check missing `.trim()` |
| tv-log-01 | `extract_start` before any validation | Logging after validation or LLM call |
| tv-schema-05 | `removeSchema` called on dynamic schema (happy path) | Missing cleanup → memory leak |
| tv-schema-07 | `removeSchema` on SCHEMA_VIOLATION (dynamic) | Cleanup in happy path only, not in `finally` |
| tv-schema-08 | `removeSchema` NOT called on INVALID_JSON (dynamic) | Cleanup on never-compiled schema |
| tv-schema-10 | `removeSchema` NOT called when `compile()` throws (dynamic) | `compile()` inside try/finally instead of before it |
| tv-log-09 | `errorType` uses `error.name` not `error.type` for non-`ExtractionFatalError` | `error?.type \|\| error?.name \|\| 'unknown'` duck-typing shortcut |

---

# ✅ SUMMARY

| Category | Vectors | Prefix |
|---|---|---|
| Interpolation | 9 | tv-interp |
| Flux extract wiring & happy path | 12 | tv-flow |
| Chemins d'erreur | 17 | tv-err |
| Schema dispatch (real Ajv) | 4 | tv-schema-01..04 |
| Schema lifecycle (mocked Ajv) | 6 | tv-schema-05..10 |
| Logging structuré | 9 | tv-log |
| Configuration Ajv | 4 | tv-ajv |
| Edge cases & idempotence | 4 | tv-edge |
| **TOTAL** | **65** | |

---

# 🛑 STOP CONDITION

After writing tests:

1. Run suite
2. Confirm explicitly:
   - All tests are RED
   - `StructuredExtractor` stub throws `'Not implemented'`
3. Provide:
   - number of tests (expected: **65**)
   - number of test files (expected: **8**)

STOP.

---

## IMPORTANT

Do not implement the package in this phase.
