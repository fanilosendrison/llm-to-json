export type ExtractionErrorType =
	| "INVALID_JSON"
	| "SCHEMA_VIOLATION"
	| "PARSE_ERROR";

export class ExtractionFatalError extends Error {
	type: ExtractionErrorType;
	rawOutput: string;
	contractId: string;
	details?: string | undefined;

	constructor(
		type: ExtractionErrorType,
		rawOutput: string,
		contractId: string,
		details?: string,
	) {
		super(
			`Extraction failed [${type}] for contract ${contractId}${details ? `: ${details}` : ""}`,
		);
		this.name = "ExtractionFatalError";
		this.type = type;
		this.rawOutput = rawOutput;
		this.contractId = contractId;
		this.details = details;
	}
}

export class TemplateInterpolationError extends Error {
	variableName: string;
	contractId: string;
	templateField: "contextDescription" | "extractionPrompt";

	constructor(
		variableName: string,
		contractId: string,
		templateField: "contextDescription" | "extractionPrompt",
	) {
		super(
			`Missing variable '${variableName}' in ${templateField} of contract ${contractId}`,
		);
		this.name = "TemplateInterpolationError";
		this.variableName = variableName;
		this.contractId = contractId;
		this.templateField = templateField;
	}
}
