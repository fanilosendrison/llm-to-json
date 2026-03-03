export interface LLMClient {
	complete(
		system: string,
		user: string,
		config: { temperature: number; maxTokens: number },
	): Promise<string>;
}
