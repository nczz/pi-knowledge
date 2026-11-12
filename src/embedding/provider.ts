import { createHash } from "node:crypto";
import { embedInModelWorker, measureEmbeddingInputInModelWorker } from "../model-worker-client.ts";
import {
	decorateEmbeddingInput,
	decorationSupportedByLocalModel,
	type EmbeddingDecorationStrategy,
	type EmbeddingInstructionSet,
	type EmbeddingPrefixMode,
	type EmbeddingRole,
	type EmbeddingTask,
	embeddingDecorationDescriptor,
	embeddingInstructionLength,
	type ResolvedEmbeddingDecoration,
	resolveEmbeddingDecoration,
} from "./instructions.ts";

export type {
	EmbeddingDecorationStrategy,
	EmbeddingInstructionSet,
	EmbeddingRole,
	EmbeddingTask,
} from "./instructions.ts";
export type EmbeddingProvider = "local" | "openai";

export interface EmbeddingConfig {
	provider: EmbeddingProvider;
	model: string;
	baseUrl?: string;
	maxChars: number;
	strategy: EmbeddingDecorationStrategy;
	task?: EmbeddingTask;
	instructions: EmbeddingInstructionSet;
	prefixMode: EmbeddingPrefixMode;
	apiFallbackToLocal: boolean;
	pooling: "mean";
	normalize: true;
}

export interface EmbeddingInputMeasurement {
	counts: number[];
	maximum: number;
	preferredMaximum: number;
	unit: "tokens" | "characters";
}

export type EmbeddingCompatibilityCause =
	| "match"
	| "unrecorded"
	| "dimension"
	| "decoration"
	| "configuration"
	| "signature_format";

export interface EmbeddingCompatibility {
	compatible: boolean;
	cause: EmbeddingCompatibilityCause;
	activeSignature: string;
	recordedSignature: string | null;
	activeDecoration: string;
	recordedDecoration?: string;
	activeDimension: number;
	recordedDimension: number | null;
}

let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];

export const CURRENT_EMBEDDING_MODEL = "multilingual-e5-small";
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "multilingual-e5-small";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const LOCAL_EMBEDDING_MAX_TOKENS = 512;
export const LOCAL_EMBEDDING_PREFERRED_TOKENS = 448;
export const DEFAULT_API_MAX_EMBED_CHARS = 20_000;
export const API_VECTOR_NORMALIZATION_POLICY = "client-l2-v1";
const IDLE_TIMEOUT_MS = Number(process.env.PI_KNOWLEDGE_EMBEDDING_IDLE_MS ?? 30_000);
const ENABLE_NATIVE_IDLE_DISPOSE = process.env.PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE === "true";

function localEmbeddingConfig(maxChars: number, decoration: ResolvedEmbeddingDecoration): EmbeddingConfig {
	return {
		provider: "local",
		model: DEFAULT_LOCAL_EMBEDDING_MODEL,
		maxChars,
		strategy: decoration.strategy,
		task: decoration.task,
		instructions: decoration.instructions,
		prefixMode: decoration.prefixMode,
		apiFallbackToLocal: false,
		pooling: "mean",
		normalize: true,
	};
}

function cleanEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function clearIdleTimer(): void {
	clearTimeout(disposeTimer ?? undefined);
	disposeTimer = null;
}

function scheduleIdleDispose(): void {
	if (activeRuns > 0 || disposeRequested) return;
	clearIdleTimer();
	if (!ENABLE_NATIVE_IDLE_DISPOSE) return;
	disposeTimer = setTimeout(() => dispose(), IDLE_TIMEOUT_MS);
}

function beginRun(): void {
	activeRuns++;
	clearIdleTimer();
}

function endRun(): void {
	activeRuns--;
	if (activeRuns > 0) return;
	for (const resolve of idleWaiters.splice(0)) resolve();
	if (!disposeRequested) scheduleIdleDispose();
}

async function waitForNoActiveRuns(): Promise<void> {
	if (activeRuns === 0) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	idleWaiters.push(resolve);
	await promise;
}

function providerInstanceHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function assertApiInstructionBudget(config: EmbeddingConfig): void {
	for (const role of ["query", "passage"] as const) {
		const instructionLength = embeddingInstructionLength(config.instructions, role);
		if (instructionLength >= config.maxChars) {
			throw new Error(
				`Embedding ${role} instruction is ${instructionLength} characters; PI_KNOWLEDGE_EMBEDDING_MAX_CHARS=${config.maxChars} must leave room for input text.`,
			);
		}
	}
}

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
	const raw = cleanEnv(env.PI_KNOWLEDGE_EMBEDDING) ?? `local:${DEFAULT_LOCAL_EMBEDDING_MODEL}`;
	const separator = raw.indexOf(":");
	const provider = separator >= 0 ? raw.slice(0, separator).toLowerCase() : raw.toLowerCase();
	const model = separator >= 0 ? raw.slice(separator + 1).trim() : "";
	const maxCharsValue = Number(cleanEnv(env.PI_KNOWLEDGE_EMBEDDING_MAX_CHARS) ?? DEFAULT_API_MAX_EMBED_CHARS);
	const maxChars =
		Number.isFinite(maxCharsValue) && maxCharsValue > 0 ? Math.trunc(maxCharsValue) : DEFAULT_API_MAX_EMBED_CHARS;
	const decoration = resolveEmbeddingDecoration(env);
	const fallback = cleanEnv(env.PI_KNOWLEDGE_EMBEDDING_API_FALLBACK)?.toLowerCase();
	if (fallback && fallback !== "local") {
		throw new Error("Unsupported embedding API fallback. Use PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local or unset it.");
	}
	const apiFallbackToLocal = fallback === "local";

	if (provider === "local") {
		const localModel = model || DEFAULT_LOCAL_EMBEDDING_MODEL;
		if (localModel !== DEFAULT_LOCAL_EMBEDDING_MODEL) {
			throw new Error(`Unsupported local embedding model: ${localModel}`);
		}
		if (!decorationSupportedByLocalModel(decoration.strategy)) {
			throw new Error(
				`Embedding decoration ${decoration.strategy} is not supported for the local embedding model. Use PI_KNOWLEDGE_EMBEDDING_PREFIXES=on|off|e5|none, or an OpenAI-compatible provider.`,
			);
		}
		return localEmbeddingConfig(maxChars, decoration);
	}

	if (provider === "openai") {
		if (apiFallbackToLocal && !decorationSupportedByLocalModel(decoration.strategy)) {
			throw new Error(
				`PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local is incompatible with embedding decoration ${decoration.strategy}; the local model supports only E5 prefixes or none.`,
			);
		}
		const config: EmbeddingConfig = {
			provider: "openai",
			model: model || DEFAULT_OPENAI_EMBEDDING_MODEL,
			baseUrl:
				cleanEnv(env.PI_KNOWLEDGE_EMBEDDING_BASE_URL) ?? cleanEnv(env.OPENAI_BASE_URL) ?? DEFAULT_OPENAI_BASE_URL,
			maxChars,
			strategy: decoration.strategy,
			task: decoration.task,
			instructions: decoration.instructions,
			prefixMode: decoration.prefixMode,
			apiFallbackToLocal,
			pooling: "mean",
			normalize: true,
		};
		assertApiInstructionBudget(config);
		return config;
	}

	throw new Error(`Unsupported embedding provider: ${provider}`);
}

export function embeddingConfigLabel(config: EmbeddingConfig): string {
	return config.provider === "local" ? config.model : `${config.provider}:${config.model}`;
}

export function normalizeEmbeddingVector(vector: Float32Array): Float32Array {
	let squaredMagnitude = 0;
	for (const value of vector) {
		if (!Number.isFinite(value)) throw new Error("Embedding provider returned a non-finite vector value");
		squaredMagnitude += value * value;
	}
	if (!Number.isFinite(squaredMagnitude) || squaredMagnitude <= 0) {
		throw new Error("Embedding provider returned a zero-magnitude vector");
	}
	const magnitude = Math.sqrt(squaredMagnitude);
	for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;
	return vector;
}

export function describeEmbeddingDecoration(config: EmbeddingConfig): string {
	return embeddingDecorationDescriptor({
		strategy: config.strategy,
		task: config.task,
		instructions: config.instructions,
		prefixMode: config.prefixMode,
	});
}

export function embeddingSignature(config: EmbeddingConfig, dimension: number): string {
	const base = config.baseUrl ? `:base-sha256=${providerInstanceHash(config.baseUrl)}` : "";
	const normalization = config.provider === "openai" ? API_VECTOR_NORMALIZATION_POLICY : String(config.normalize);
	return [
		`${config.provider}:${config.model}${base}`,
		`dim=${dimension}`,
		`apiMax=${config.provider === "openai" ? config.maxChars : "none"}`,
		`pooling=${config.pooling}`,
		`normalize=${normalization}`,
		describeEmbeddingDecoration(config),
	].join(":");
}

const RECORDED_DECORATION_PATTERN =
	/:(q=query:d=passage(?::prefixes=off)?|strategy=(?:jina-code|custom)(?::task=[a-z0-9-]+)?:ih=[0-9a-f]{12})$/;

export function recordedEmbeddingDecoration(signature: string | null): string | undefined {
	if (!signature) return undefined;
	return RECORDED_DECORATION_PATTERN.exec(signature)?.[1];
}

export function inspectEmbeddingCompatibility(
	recordedSignature: string | null,
	recordedDimension: number | null,
	config: EmbeddingConfig,
	activeDimension: number,
): EmbeddingCompatibility {
	const activeSignature = embeddingSignature(config, activeDimension);
	const activeDecoration = describeEmbeddingDecoration(config);
	const base = {
		activeSignature,
		recordedSignature,
		activeDecoration,
		activeDimension,
		recordedDimension,
	};
	if (!recordedSignature || recordedDimension === null) {
		return { ...base, compatible: false, cause: "unrecorded" };
	}
	const recordedDecoration = recordedEmbeddingDecoration(recordedSignature);
	if (recordedDimension !== activeDimension) {
		return { ...base, compatible: false, cause: "dimension", recordedDecoration };
	}
	if (recordedSignature === activeSignature) {
		return { ...base, compatible: true, cause: "match", recordedDecoration };
	}
	if (!recordedDecoration) {
		return { ...base, compatible: false, cause: "signature_format" };
	}
	if (recordedDecoration !== activeDecoration) {
		const recordedBase = recordedSignature.slice(0, recordedSignature.length - recordedDecoration.length - 1);
		const activeBase = activeSignature.slice(0, activeSignature.length - activeDecoration.length - 1);
		if (recordedBase === activeBase) {
			return { ...base, compatible: false, cause: "decoration", recordedDecoration };
		}
	}
	return { ...base, compatible: false, cause: "configuration", recordedDecoration };
}

export function describeEmbeddingCompatibility(compatibility: EmbeddingCompatibility): string {
	switch (compatibility.cause) {
		case "match":
			return "indexed vectors match the active embedding configuration";
		case "unrecorded":
			return "the indexed embedding signature or dimension is missing";
		case "dimension":
			return `indexed dimension ${compatibility.recordedDimension ?? "unknown"} differs from active dimension ${compatibility.activeDimension}`;
		case "decoration":
			return `indexed decoration ${compatibility.recordedDecoration ?? "unknown"} differs from active decoration ${compatibility.activeDecoration}`;
		case "configuration":
			return "the indexed provider, model, endpoint, input limit, pooling, or normalization differs from the active configuration";
		case "signature_format":
			return "the indexed embedding signature cannot be interpreted";
	}
}

export function dispose(): Promise<void> {
	clearIdleTimer();
	if (disposePromise) return disposePromise;
	disposeRequested = true;
	disposePromise = waitForNoActiveRuns().finally(() => {
		disposePromise = null;
		disposeRequested = false;
	});
	return disposePromise;
}

export async function prepareForShutdown(): Promise<void> {
	clearIdleTimer();
	await waitForNoActiveRuns();
}

function prepareEmbeddingInputs(texts: string[], role: EmbeddingRole, config: EmbeddingConfig): string[] {
	return texts.map((text) => decorateEmbeddingInput(text, role, config.instructions));
}

function apiInputMeasurement(preparedInputs: string[], config: EmbeddingConfig): EmbeddingInputMeasurement {
	return {
		counts: preparedInputs.map((text) => text.length),
		maximum: config.maxChars,
		preferredMaximum: Math.max(1, Math.floor(config.maxChars * 0.875)),
		unit: "characters",
	};
}

export async function measureEmbeddingInputs(
	texts: string[],
	role: EmbeddingRole,
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<EmbeddingInputMeasurement> {
	if (signal?.aborted) throw new Error("Cancelled");
	if (config.provider === "openai") {
		return apiInputMeasurement(prepareEmbeddingInputs(texts, role, config), config);
	}
	beginRun();
	try {
		const measurement = await measureEmbeddingInputInModelWorker(texts, role, config.prefixMode, signal);
		return {
			...measurement,
			preferredMaximum: Math.max(1, Math.floor(measurement.maximum * 0.875)),
			unit: "tokens",
		};
	} finally {
		endRun();
	}
}

function assertMeasurementWithinBudget(
	measurement: EmbeddingInputMeasurement,
	role: EmbeddingRole,
	provider: EmbeddingProvider,
): void {
	for (let index = 0; index < measurement.counts.length; index++) {
		const count = measurement.counts[index];
		if (count !== undefined && count > measurement.maximum) {
			throw new Error(
				`${provider} embedding ${role} input ${index + 1} is ${count} ${measurement.unit}; maximum is ${measurement.maximum}. Split the input before embedding.`,
			);
		}
	}
}

async function assertLocalInputsWithinBudget(
	texts: string[],
	role: EmbeddingRole,
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<void> {
	assertMeasurementWithinBudget(await measureEmbeddingInputs(texts, role, config, signal), role, config.provider);
}

async function embedPreparedInputsViaAPI(
	preparedInputs: string[],
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	const apiKey = cleanEnv(process.env.PI_KNOWLEDGE_EMBEDDING_API_KEY) ?? cleanEnv(process.env.OPENAI_API_KEY);
	if (!config.baseUrl) throw new Error("OpenAI embedding base URL is not configured");
	const endpoint = new URL("embeddings", `${config.baseUrl.replace(/\/+$/, "")}/`);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ input: preparedInputs, model: config.model }),
		signal,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`OpenAI embedding API error: ${res.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
	}
	const payload = (await res.json()) as unknown;
	if (!payload || typeof payload !== "object" || !("data" in payload && Array.isArray(payload.data))) {
		throw new Error("OpenAI embedding API response is missing a data array");
	}
	if (payload.data.length !== preparedInputs.length) {
		throw new Error(`OpenAI embedding API returned ${payload.data.length} vectors for ${preparedInputs.length} inputs`);
	}
	let expectedDimension: number | undefined;
	return payload.data.map((item, index) => {
		if (!item || typeof item !== "object" || !("embedding" in item && Array.isArray(item.embedding))) {
			throw new Error(`OpenAI embedding API response item ${index + 1} is missing an embedding array`);
		}
		if (expectedDimension !== undefined && item.embedding.length !== expectedDimension) {
			throw new Error(
				`OpenAI embedding API response item ${index + 1} has dimension ${item.embedding.length}; expected ${expectedDimension}`,
			);
		}
		expectedDimension = item.embedding.length;
		const vector = new Float32Array(item.embedding.length);
		for (let valueIndex = 0; valueIndex < item.embedding.length; valueIndex++) {
			const value = item.embedding[valueIndex];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(
					`OpenAI embedding API response item ${index + 1} contains a non-finite numeric value at position ${valueIndex}`,
				);
			}
			vector[valueIndex] = value;
		}
		return normalizeEmbeddingVector(vector);
	});
}

export async function embedTextsWithConfig(
	texts: string[],
	role: EmbeddingRole,
	signal?: AbortSignal,
	options: { allowApiFallback?: boolean; inputValidated?: boolean } = {},
): Promise<{ vectors: Float32Array[]; config: EmbeddingConfig }> {
	const config = resolveEmbeddingConfig();
	let actualConfig = config;
	let inputValidated = options.inputValidated === true;
	if (config.provider === "openai") {
		const preparedInputs = prepareEmbeddingInputs(texts, role, config);
		if (!inputValidated) {
			assertMeasurementWithinBudget(apiInputMeasurement(preparedInputs, config), role, config.provider);
		}
		if (signal?.aborted) throw new Error("Cancelled");
		try {
			return { vectors: await embedPreparedInputsViaAPI(preparedInputs, config, signal), config };
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw new Error("Cancelled");
			if (!config.apiFallbackToLocal || !options.allowApiFallback) throw error;
			console.warn(
				`pi-knowledge: embedding API failed; falling back to local model because PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local (${error instanceof Error ? error.message : String(error)})`,
			);
			actualConfig = localEmbeddingConfig(config.maxChars, {
				strategy: config.strategy,
				task: config.task,
				instructions: config.instructions,
				prefixMode: config.prefixMode,
			});
			inputValidated = false;
		}
	}
	if (!inputValidated) await assertLocalInputsWithinBudget(texts, role, actualConfig, signal);
	beginRun();
	try {
		return {
			vectors: await embedInModelWorker(texts, role, actualConfig.prefixMode, signal),
			config: actualConfig,
		};
	} finally {
		endRun();
	}
}

export async function embedTexts(
	texts: string[],
	role: EmbeddingRole,
	signal?: AbortSignal,
	options: { allowApiFallback?: boolean; inputValidated?: boolean } = {},
): Promise<Float32Array[]> {
	return (await embedTextsWithConfig(texts, role, signal, options)).vectors;
}

export async function embedQueryWithConfig(
	text: string,
	signal?: AbortSignal,
): Promise<{ vector: Float32Array; config: EmbeddingConfig }> {
	const { vectors, config } = await embedTextsWithConfig([text], "query", signal, { allowApiFallback: true });
	const vector = vectors[0];
	if (!vector) throw new Error("Embedding provider returned no query vector");
	return { vector, config };
}

export async function embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
	return (await embedQueryWithConfig(text, signal)).vector;
}

export async function embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	return embedTexts(texts, "passage", signal, { allowApiFallback: false });
}

export async function embedValidatedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	return embedTexts(texts, "passage", signal, { allowApiFallback: false, inputValidated: true });
}
