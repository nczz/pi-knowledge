export type RawLogitRerankInput = {
	text: string;
	text_pair: string;
};

export type RawLogitTokenizer = (
	text: string,
	options: { text_pair: string; padding: true; truncation: true },
) => Record<string, unknown>;

export type RawLogitModel = (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>;

export function scoreSingleRawLogit(logits: { data: ArrayLike<number> }, model: string): number {
	const scores = Array.from(logits.data);
	if (scores.length !== 1) {
		throw new Error(
			`Raw-logit reranker expected a single-logit sequence classifier for ${model}, got ${scores.length} logits. ` +
				"Use a single-logit reranker model or disable PI_KNOWLEDGE_RERANKER_RAW_LOGITS.",
		);
	}
	const score = scores[0];
	if (!Number.isFinite(score)) throw new Error(`Raw-logit reranker returned a non-finite score for ${model}`);
	return score;
}

export async function rerankWithSingleRawLogit(
	input: RawLogitRerankInput,
	tokenizer: RawLogitTokenizer,
	model: RawLogitModel,
	modelName: string,
): Promise<Array<{ score: number }>> {
	const inputs = tokenizer(input.text, { text_pair: input.text_pair, padding: true, truncation: true });
	const { logits } = await model(inputs);
	return [{ score: scoreSingleRawLogit(logits, modelName) }];
}
