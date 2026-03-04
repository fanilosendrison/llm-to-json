import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StructuredExtractor } from "../src/index";
import {
	ExtractionFatalError,
	TemplateInterpolationError,
} from "../src/errors";
import type { LLMClient } from "../src/llm-client";
import type { ExtractionContract } from "../src/contract";
import type { JSONSchema } from "../src/schema";
import { mockLLMClient, simpleContract } from "./helpers";

let extractor: StructuredExtractor;
let llmClient: LLMClient;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	llmClient = mockLLMClient('{"name":"default","age":0}');
	extractor = new StructuredExtractor(llmClient);
	consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	consoleSpy.mockRestore();
});

function parseLogEntry(callIndex: number): Record<string, unknown> {
	const call = consoleSpy.mock.calls[callIndex];
	expect(call).toHaveLength(1);
	return JSON.parse(call![0] as string) as Record<string, unknown>;
}

describe("Integration: extract() 10-step end-to-end flow", () => {
	it("full happy path: interpolate → LLM → JSON.parse → Ajv → parse → T", async () => {
		llmClient = mockLLMClient('{"name":"Alice","age":30}');
		extractor = new StructuredExtractor(llmClient);
		const contract: ExtractionContract<{
			name: string;
			age: number;
			source: string;
		}> = {
			id: "INT-01",
			sourceAgent: "IntegrationAgent",
			contextDescription: "Agent {{agent_name}} produced: {{agent_response}}",
			extractionPrompt: "Extract name/age from: {{agent_response}}",
			outputSchema: {
				type: "object",
				properties: {
					name: { type: "string" },
					age: { type: "integer", minimum: 0 },
				},
				required: ["name", "age"],
				additionalProperties: false,
			},
			parse(raw) {
				const data = raw as { name: string; age: number };
				return { ...data, source: "parsed" };
			},
		};

		const result = await extractor.extract("raw LLM output", contract, {
			agent_name: "Worker",
		});

		// Verify interpolation happened correctly
		expect(llmClient.complete).toHaveBeenCalledWith(
			"Agent Worker produced: raw LLM output",
			"Extract name/age from: raw LLM output",
			{ temperature: 0, maxTokens: 1024 },
		);
		// Verify parse() enriched the result
		expect(result).toEqual({ name: "Alice", age: 30, source: "parsed" });
		// Verify logging pairing
		expect(consoleSpy).toHaveBeenCalledTimes(2);
		expect(parseLogEntry(0)["event"]).toBe("extract_start");
		expect(parseLogEntry(1)["event"]).toBe("extract_end");
		expect(parseLogEntry(1)["success"]).toBe(true);
	});

	it("interpolation error stops flow before LLM call, with correct logging", async () => {
		const contract = {
			...simpleContract,
			id: "INT-02",
			sourceAgent: "IntAgent",
			contextDescription: "Need {{missing_ctx_var}}",
		};

		const error = await extractor
			.extract("input", contract, {})
			.catch((e: unknown) => e);

		// Interpolation error, not wrapped
		expect(error).toBeInstanceOf(TemplateInterpolationError);
		const tipError = error as TemplateInterpolationError;
		expect(tipError.variableName).toBe("missing_ctx_var");
		expect(tipError.contractId).toBe("INT-02");
		// LLM never called
		expect(llmClient.complete).not.toHaveBeenCalled();
		// Logging still paired
		expect(consoleSpy).toHaveBeenCalledTimes(2);
		expect(parseLogEntry(1)["errorType"]).toBe("TemplateInterpolationError");
	});

	it("schema validation composes with parse: schema passes then parse fails → PARSE_ERROR", async () => {
		llmClient = mockLLMClient('{"count":5,"items":["a","b"]}');
		extractor = new StructuredExtractor(llmClient);
		const contract: ExtractionContract<{
			count: number;
			items: string[];
		}> = {
			id: "INT-03",
			sourceAgent: "IntAgent",
			contextDescription: "{{agent_response}}",
			extractionPrompt: "{{agent_response}}",
			outputSchema: {
				type: "object",
				properties: {
					count: { type: "integer" },
					items: { type: "array", items: { type: "string" } },
				},
				required: ["count", "items"],
				additionalProperties: false,
			},
			parse(raw) {
				const data = raw as { count: number; items: string[] };
				// Cross-validation invariant: count must match items.length
				if (data.count !== data.items.length) {
					throw new Error(
						`count mismatch: ${data.count} vs ${data.items.length}`,
					);
				}
				return data;
			},
		};

		const error = await extractor
			.extract("input", contract, {})
			.catch((e: unknown) => e);

		// Schema passed (valid JSON structure), but parse() caught the invariant
		expect(error).toBeInstanceOf(ExtractionFatalError);
		const fatal = error as ExtractionFatalError;
		expect(fatal.type).toBe("PARSE_ERROR");
		expect(fatal.details).toBe("count mismatch: 5 vs 2");
		expect(fatal.contractId).toBe("INT-03");
	});

	it("dynamic schema + interpolation + agent_response injection all compose", async () => {
		const stringSchema: JSONSchema = {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		};
		const numberSchema: JSONSchema = {
			type: "object",
			properties: { value: { type: "number" } },
			required: ["value"],
			additionalProperties: false,
		};

		llmClient = mockLLMClient('{"value":"hello"}');
		extractor = new StructuredExtractor(llmClient);
		const outputSchemaFn = vi.fn(
			(vars: Record<string, string>): JSONSchema =>
				vars["mode"] === "string" ? stringSchema : numberSchema,
		);
		const contract = {
			...simpleContract,
			id: "INT-04",
			contextDescription: "Mode: {{mode}}, Input: {{agent_response}}",
			extractionPrompt: "Extract {{mode}} from: {{agent_response}}",
			outputSchema: outputSchemaFn,
			parse: (raw: unknown) => raw as { name: string; age: number },
		};

		await extractor.extract("some text", contract, { mode: "string" });

		// Schema function received variables with agent_response injected
		expect(outputSchemaFn).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "string",
				agent_response: "some text",
			}),
		);
		// Interpolation worked in both templates
		expect(llmClient.complete).toHaveBeenCalledWith(
			"Mode: string, Input: some text",
			"Extract string from: some text",
			expect.any(Object),
		);
	});

	it("multiple sequential calls are independent (stateless)", async () => {
		const completeMock = vi.fn();
		completeMock
			.mockResolvedValueOnce('{"name":"First","age":1}')
			.mockResolvedValueOnce('{"name":"Second","age":2}');
		const client: LLMClient = { complete: completeMock };
		const ext = new StructuredExtractor(client);

		const r1 = await ext.extract("call 1", simpleContract, {});
		const r2 = await ext.extract("call 2", simpleContract, {});

		expect(r1).toEqual({ name: "First", age: 1 });
		expect(r2).toEqual({ name: "Second", age: 2 });
		expect(completeMock).toHaveBeenCalledTimes(2);
		// 4 log entries: 2 × (extract_start + extract_end)
		expect(consoleSpy).toHaveBeenCalledTimes(4);
	});

	it("error after successful call does not corrupt state", async () => {
		const completeMock = vi.fn();
		completeMock
			.mockResolvedValueOnce('{"name":"OK","age":1}')
			.mockResolvedValueOnce("not json");
		const client: LLMClient = { complete: completeMock };
		const ext = new StructuredExtractor(client);

		// First call succeeds
		const r1 = await ext.extract("call 1", simpleContract, {});
		expect(r1).toEqual({ name: "OK", age: 1 });

		// Second call fails with INVALID_JSON
		const error = await ext
			.extract("call 2", simpleContract, {})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ExtractionFatalError);
		expect((error as ExtractionFatalError).type).toBe("INVALID_JSON");

		// Third call: extractor still works (not corrupted)
		completeMock.mockResolvedValueOnce('{"name":"Recovered","age":3}');
		const r3 = await ext.extract("call 3", simpleContract, {});
		expect(r3).toEqual({ name: "Recovered", age: 3 });
	});
});
