import { preTokenizeForFTS } from "../indexer/chunker.ts";

export const STOP_WORDS = new Set([
	"the",
	"and",
	"or",
	"to",
	"of",
	"in",
	"on",
	"for",
	"with",
	"how",
	"does",
	"what",
	"when",
	"where",
	"why",
	"this",
	"that",
	"from",
]);

const TYPO_CORRECTIONS: Record<string, string> = {
	ho: "how",
	setpup: "setup",
	setpu: "setup",
	seting: "setting",
	configuraiton: "configuration",
	permisson: "permission",
	permisions: "permissions",
};

export function stemToken(token: string): string {
	if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
	if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
	return token;
}

export function tokenizeForSearch(text: string): Set<string> {
	const normalized = preTokenizeForFTS(text)
		.toLowerCase()
		.replace(/[-_*"(){}[\]^~:+.#@!\\/<>|&$%?]/g, " ");
	const tokens = normalized
		.split(/\s+/)
		.map((token) => TYPO_CORRECTIONS[token] ?? token)
		.filter((token) => token.length > 1 || /[\u3400-\u4dbf\u4e00-\u9fff]/.test(token));
	return new Set(tokens);
}

export function signalTokens(tokens: Set<string>): Set<string> {
	return new Set([...tokens].filter((token) => !STOP_WORDS.has(token)).map(stemToken));
}

export function normalizedQueryText(query: string): string {
	return [...tokenizeForSearch(query)].join(" ");
}
