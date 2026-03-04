import Ajv from "ajv";
import type { ExtractionContract } from "./contract";
import { ExtractionFatalError } from "./errors";
import { interpolate } from "./interpolate";
import type { LLMClient } from "./llm-client";
import type { JSONSchema } from "./schema";

/** Extract a human-readable message from an unknown thrown value. */
function extractMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Derive the errorType field for extract_end logging.
 *
 * Priority: instanceof ExtractionFatalError → error.type,
 * then error.name for any object that has one, else 'unknown'.
 * Never duck-type on error.type for non-ExtractionFatalError.
 */
function deriveErrorType(error: unknown): string {
	if (error instanceof ExtractionFatalError) return error.type;
	if (typeof error === "object" && error !== null && "name" in error) {
		return String((error as { name: unknown }).name);
	}
	return "unknown";
}

export class StructuredExtractor {
	private readonly llmClient: LLMClient;
	private readonly ajv: Ajv;

	constructor(llmClient: LLMClient) {
		this.llmClient = llmClient;
		this.ajv = new Ajv({
			allErrors: false,
			coerceTypes: false,
			useDefaults: false,
			strict: true,
		});
	}

	async extract<T>(
		agentResponse: string,
		contract: ExtractionContract<T>,
		variables: Record<string, string>,
	): Promise<T> {
		// Step 0: Log extract_start — before any validation
		console.error(
			JSON.stringify({
				event: "extract_start",
				contractId: contract.id,
				sourceAgent: contract.sourceAgent,
				timestamp: new Date().toISOString(),
			}),
		);

		try {
			// Step 1: Validate agentResponse
			if (agentResponse.trim() === "") {
				throw new TypeError("agentResponse must be a non-empty string");
			}

			// Step 2: Clone variables + inject agent_response
			const vars = { ...variables };
			vars.agent_response = agentResponse;

			// Step 3: Validate maxTokens
			if (contract.maxTokens !== undefined) {
				if (!Number.isInteger(contract.maxTokens) || contract.maxTokens <= 0) {
					throw new TypeError("maxTokens must be a positive integer");
				}
			}

			// Step 4: Interpolate templates
			const system = interpolate(
				contract.contextDescription,
				vars,
				contract.id,
				"contextDescription",
			);
			const user = interpolate(
				contract.extractionPrompt,
				vars,
				contract.id,
				"extractionPrompt",
			);

			// Step 5: Resolve schema (static vs dynamic)
			const isDynamic = typeof contract.outputSchema === "function";
			const resolvedSchema: JSONSchema = isDynamic
				? (contract.outputSchema as (v: Record<string, string>) => JSONSchema)(
						vars,
					)
				: (contract.outputSchema as JSONSchema);

			// Step 6: Call LLM
			const rawResponse = await this.llmClient.complete(system, user, {
				temperature: 0,
				maxTokens: contract.maxTokens ?? 1024,
			});

			// Step 7: JSON.parse — no markdown strip, raw → JSON.parse
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawResponse);
			} catch (error) {
				throw new ExtractionFatalError(
					"INVALID_JSON",
					rawResponse,
					contract.id,
					extractMessage(error),
				);
			}

			// Step 8: Ajv compile — outside the finally scope
			// If compile throws (malformed schema), removeSchema is NOT called
			const validate = this.ajv.compile(resolvedSchema);
			let result!: T;
			try {
				// Step 8 (cont.): Ajv validate
				if (!validate(parsed)) {
					throw new ExtractionFatalError(
						"SCHEMA_VIOLATION",
						rawResponse,
						contract.id,
						this.ajv.errorsText(validate.errors),
					);
				}

				// Step 9: contract.parse(parsed) — receives raw JSON.parse output
				try {
					result = contract.parse(parsed);
				} catch (error) {
					throw new ExtractionFatalError(
						"PARSE_ERROR",
						rawResponse,
						contract.id,
						extractMessage(error),
					);
				}
			} finally {
				// Cleanup dynamic schemas to prevent memory leaks.
				// We rely on Ajv v8 behavior: removeSchema(object) deletes via Map identity
				// lookup on the exact schema reference (not by $id or serialization).
				// Same object reference as resolvedSchema from step 5. Covered by tv-schema-05.
				// See: ajv/lib/core.ts — Ajv.removeSchema() → this.schemas Map.delete(schema)
				if (isDynamic) {
					this.ajv.removeSchema(resolvedSchema);
				}
			}

			// Step 10: Log success + return
			console.error(
				JSON.stringify({
					event: "extract_end",
					contractId: contract.id,
					sourceAgent: contract.sourceAgent,
					success: true,
					timestamp: new Date().toISOString(),
				}),
			);
			return result;
		} catch (error) {
			// Logging-only catch: observe, log, re-throw unchanged
			console.error(
				JSON.stringify({
					event: "extract_end",
					contractId: contract.id,
					sourceAgent: contract.sourceAgent,
					success: false,
					errorType: deriveErrorType(error),
					timestamp: new Date().toISOString(),
				}),
			);
			throw error;
		}
	}
}
