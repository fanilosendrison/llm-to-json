import { TemplateInterpolationError } from "./errors";

/** Normative pattern — identifiers only, no spaces inside braces */
const PLACEHOLDER_REGEX = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

/**
 * Replace {{variable_name}} placeholders in a template string.
 *
 * Uses function replacement (not string replacement) to avoid
 * interpretation of $ sequences in variable values.
 */
export function interpolate(
	template: string,
	variables: Record<string, string>,
	contractId: string,
	templateField: "contextDescription" | "extractionPrompt",
): string {
	return template.replace(PLACEHOLDER_REGEX, (_match, name: string) => {
		if (!(name in variables)) {
			throw new TemplateInterpolationError(name, contractId, templateField);
		}
		// Safe: `in` check above guarantees the key exists
		return variables[name] as string;
	});
}
