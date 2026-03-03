---
id: SPEC-ARBO-LLM-TO-JSON
version: "0.1.0"
scope: Arborescence cible du package llm-to-json
status: draft
validates: [src/*.ts, tests/*.ts]
---

# Arborescence cible — llm-to-json

```
llm-to-json/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # re-exports publics
│   ├── extractor.ts                # StructuredExtractor
│   ├── errors.ts                   # ExtractionFatalError, TemplateInterpolationError
│   ├── interpolate.ts              # interpolation {{var}} avec safe $
│   ├── contract.ts                 # ExtractionContract<T> type
│   ├── llm-client.ts               # LLMClient interface
│   └── schema.ts                   # JSONSchema type re-export
└── tests/
    ├── helpers.ts                   # mockLLMClient, mockLLMClientRejecting, simpleContract
    ├── interpolation.test.ts        # tv-interp-01..09
    ├── extract-flow.test.ts         # tv-flow-01..12
    ├── errors.test.ts               # tv-err-01..16b
    ├── schema-dispatch.test.ts      # tv-schema-01..04
    ├── schema-lifecycle.test.ts     # tv-schema-05..10
    ├── logging.test.ts              # tv-log-01..09
    ├── ajv-config.test.ts           # tv-ajv-01..04
    └── edge-cases.test.ts           # tv-edge-01..04
```
