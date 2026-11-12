import { createHash } from "node:crypto";

export type EmbeddingRole = "query" | "passage";
export type EmbeddingDecorationStrategy = "e5" | "none" | "jina-code" | "custom";
export type EmbeddingTask = "nl2code" | "code2code" | "code2nl" | "code2completion" | "qa";
export type EmbeddingPrefixMode = "on" | "off";

export interface EmbeddingInstructionSet {
	query: string;
	document: string;
}

export interface ResolvedEmbeddingDecoration {
	strategy: EmbeddingDecorationStrategy;
	task?: EmbeddingTask;
	instructions: EmbeddingInstructionSet;
	prefixMode: EmbeddingPrefixMode;
}

export const MAX_INSTRUCTION_CHARS = 512;
export const DEFAULT_EMBEDDING_TASK: EmbeddingTask = "nl2code";
export const ACCEPTED_DECORATION_VALUES = ["on", "off", "e5", "none", "jina", "jina-code", "custom"] as const;
export const ACCEPTED_EMBEDDING_TASKS = ["nl2code", "code2code", "code2nl", "code2completion", "qa"] as const;

const STRATEGY_ALIASES: Readonly<Record<string, EmbeddingDecorationStrategy>> = {
	on: "e5",
	e5: "e5",
	off: "none",
	none: "none",
	jina: "jina-code",
	"jina-code": "jina-code",
	custom: "custom",
};

const STRATEGY_ENV = "PI_KNOWLEDGE_EMBEDDING_PREFIXES";
const TASK_ENV = "PI_KNOWLEDGE_EMBEDDING_TASK";
const QUERY_INSTRUCTION_ENV = "PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION";
const DOCUMENT_INSTRUCTION_ENV = "PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION";

export const E5_INSTRUCTIONS: EmbeddingInstructionSet = Object.freeze({ query: "query: ", document: "passage: " });
export const NO_INSTRUCTIONS: EmbeddingInstructionSet = Object.freeze({ query: "", document: "" });

/**
 * Published prompts for jinaai/jina-code-embeddings-1.5b.
 * Source: config_sentence_transformers.json at model revision
 * 39aeb4fb9b60f930934c78ae5d749a46287c248a (verified 2026-11-12).
 * Values already contain their required trailing newline and are concatenated verbatim.
 */
export const JINA_CODE_INSTRUCTIONS: Readonly<Record<EmbeddingTask, EmbeddingInstructionSet>> = Object.freeze({
	nl2code: Object.freeze({
		query: "Find the most relevant code snippet given the following query:\n",
		document: "Candidate code snippet:\n",
	}),
	code2code: Object.freeze({
		query: "Find an equivalent code snippet given the following code snippet:\n",
		document: "Candidate code snippet:\n",
	}),
	code2nl: Object.freeze({
		query: "Find the most relevant comment given the following code snippet:\n",
		document: "Candidate comment:\n",
	}),
	code2completion: Object.freeze({
		query: "Find the most relevant completion given the following start of code snippet:\n",
		document: "Candidate completion:\n",
	}),
	qa: Object.freeze({
		query: "Find the most relevant answer given the following question:\n",
		document: "Candidate answer:\n",
	}),
});

export function decorateEmbeddingInput(
	text: string,
	role: EmbeddingRole,
	instructions: EmbeddingInstructionSet,
): string {
	return `${role === "query" ? instructions.query : instructions.document}${text}`;
}

export function embeddingInstructionLength(instructions: EmbeddingInstructionSet, role: EmbeddingRole): number {
	return (role === "query" ? instructions.query : instructions.document).length;
}

export function embeddingInstructionSetHash(instructions: EmbeddingInstructionSet): string {
	return createHash("sha256")
		.update(JSON.stringify([instructions.query, instructions.document]))
		.digest("hex")
		.slice(0, 12);
}

export function embeddingDecorationDescriptor(decoration: ResolvedEmbeddingDecoration): string {
	if (decoration.strategy === "e5") return "q=query:d=passage";
	if (decoration.strategy === "none") return "q=query:d=passage:prefixes=off";
	const instructionHash = embeddingInstructionSetHash(decoration.instructions);
	if (decoration.strategy === "jina-code") {
		return `strategy=jina-code:task=${decoration.task ?? DEFAULT_EMBEDDING_TASK}:ih=${instructionHash}`;
	}
	return `strategy=custom:ih=${instructionHash}`;
}

function cleanValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function assertInstructionValue(name: string, value: string): void {
	if (value.length > MAX_INSTRUCTION_CHARS) {
		throw new Error(
			`Embedding instruction ${name} is ${value.length} characters; maximum is ${MAX_INSTRUCTION_CHARS}.`,
		);
	}
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (character !== "\n" && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) {
			throw new Error(
				`Embedding instruction ${name} contains an unsupported control character; only printable text and newline are allowed.`,
			);
		}
	}
}

function resolveCustomInstructions(env: NodeJS.ProcessEnv): EmbeddingInstructionSet {
	const query = env[QUERY_INSTRUCTION_ENV];
	const document = env[DOCUMENT_INSTRUCTION_ENV];
	const missing = [
		query === undefined ? QUERY_INSTRUCTION_ENV : "",
		document === undefined ? DOCUMENT_INSTRUCTION_ENV : "",
	].filter(Boolean);
	if (missing.length > 0) throw new Error(`${STRATEGY_ENV}=custom requires ${missing.join(" and ")}.`);
	if (query === undefined || document === undefined) throw new Error("Embedding instruction resolution failed");
	if (!query.trim()) throw new Error(`${QUERY_INSTRUCTION_ENV} must be a non-empty string.`);
	assertInstructionValue(QUERY_INSTRUCTION_ENV, query);
	assertInstructionValue(DOCUMENT_INSTRUCTION_ENV, document);
	return Object.freeze({ query, document });
}

export function resolveEmbeddingDecoration(env: NodeJS.ProcessEnv): ResolvedEmbeddingDecoration {
	const rawStrategy = cleanValue(env[STRATEGY_ENV])?.toLowerCase();
	const strategy = rawStrategy ? STRATEGY_ALIASES[rawStrategy] : "e5";
	if (!strategy) {
		throw new Error(
			`Unsupported embedding decoration strategy: ${rawStrategy}. Use ${STRATEGY_ENV}=${ACCEPTED_DECORATION_VALUES.join("|")}.`,
		);
	}

	const customVariablesPresent =
		env[QUERY_INSTRUCTION_ENV] !== undefined || env[DOCUMENT_INSTRUCTION_ENV] !== undefined;
	if (strategy !== "custom" && customVariablesPresent) {
		throw new Error(
			`${QUERY_INSTRUCTION_ENV} and ${DOCUMENT_INSTRUCTION_ENV} are valid only when ${STRATEGY_ENV}=custom.`,
		);
	}

	const rawTask = cleanValue(env[TASK_ENV])?.toLowerCase();
	let task: EmbeddingTask | undefined;
	if (rawTask) {
		if (strategy !== "jina-code") {
			throw new Error(`${TASK_ENV} is valid only when ${STRATEGY_ENV}=jina-code.`);
		}
		if (!(ACCEPTED_EMBEDDING_TASKS as readonly string[]).includes(rawTask)) {
			throw new Error(`Unsupported embedding task: ${rawTask}. Use ${TASK_ENV}=${ACCEPTED_EMBEDDING_TASKS.join("|")}.`);
		}
		task = rawTask as EmbeddingTask;
	} else if (strategy === "jina-code") {
		task = DEFAULT_EMBEDDING_TASK;
	}

	let instructions: EmbeddingInstructionSet;
	if (strategy === "e5") instructions = E5_INSTRUCTIONS;
	else if (strategy === "none") instructions = NO_INSTRUCTIONS;
	else if (strategy === "jina-code") instructions = JINA_CODE_INSTRUCTIONS[task ?? DEFAULT_EMBEDDING_TASK];
	else instructions = resolveCustomInstructions(env);

	return Object.freeze({
		strategy,
		task,
		instructions,
		prefixMode: strategy === "e5" ? "on" : "off",
	});
}

export function decorationSupportedByLocalModel(strategy: EmbeddingDecorationStrategy): boolean {
	return strategy === "e5" || strategy === "none";
}
