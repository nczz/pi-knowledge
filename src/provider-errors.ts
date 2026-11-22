import { isObjectRecord } from "./type-guards.ts";

export type ProviderName = "embedding" | "reranker";
export type ProviderOperation = "embed_query" | "embed_documents" | "rerank";
export type ProviderFailureKind = "http" | "network" | "timeout" | "cancelled";
export type ProviderFailureRetryability = "retryable" | "non_retryable" | "unknown";

export interface ProviderFailureDetails {
	provider: ProviderName;
	operation: ProviderOperation;
	kind: ProviderFailureKind;
	status?: number;
	code?: string;
}

const PROVIDERS: Record<ProviderName, true> = {
	embedding: true,
	reranker: true,
};

const OPERATIONS: Record<ProviderOperation, true> = {
	embed_query: true,
	embed_documents: true,
	rerank: true,
};

const FAILURE_KINDS: Record<ProviderFailureKind, true> = {
	http: true,
	network: true,
	timeout: true,
	cancelled: true,
};

const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const PROVIDER_FAILURE_KEYS = new Set(["provider", "operation", "kind", "status", "code"]);

function safeErrorCode(value: unknown): string | undefined {
	const candidate = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
	return typeof candidate === "string" && SAFE_CODE_PATTERN.test(candidate) ? candidate : undefined;
}

function nestedErrorCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 3; depth++) {
		if (!isObjectRecord(current)) return undefined;
		const code = safeErrorCode(current.code);
		if (code) return code;
		current = current.cause;
	}
	return undefined;
}

export function isAbortError(error: unknown): boolean {
	return isObjectRecord(error) && error.name === "AbortError";
}

export function isProviderFailureDetails(value: unknown): value is ProviderFailureDetails {
	if (!isObjectRecord(value)) return false;
	if (typeof value.provider !== "string" || !Object.hasOwn(PROVIDERS, value.provider)) return false;
	if (typeof value.operation !== "string" || !Object.hasOwn(OPERATIONS, value.operation)) return false;
	if (typeof value.kind !== "string" || !Object.hasOwn(FAILURE_KINDS, value.kind)) return false;
	if (Object.keys(value).some((key) => !PROVIDER_FAILURE_KEYS.has(key))) return false;
	if (
		(value.provider === "embedding" && value.operation === "rerank") ||
		(value.provider === "reranker" && value.operation !== "rerank")
	) {
		return false;
	}
	if (
		value.status !== undefined &&
		(typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599)
	) {
		return false;
	}
	if (value.code !== undefined && safeErrorCode(value.code) === undefined) return false;
	if (value.kind === "http" ? value.status === undefined : value.status !== undefined) return false;
	if (value.kind !== "network" && value.code !== undefined) return false;
	return true;
}

export class ProviderError extends Error {
	readonly providerFailure: ProviderFailureDetails;
	readonly provider: ProviderName;
	readonly operation: ProviderOperation;
	readonly kind: ProviderFailureKind;
	readonly status?: number;
	readonly code?: string;

	constructor(message: string, providerFailure: ProviderFailureDetails, options?: ErrorOptions) {
		if (!isProviderFailureDetails(providerFailure)) throw new TypeError("Invalid provider failure details");
		super(message, options);
		this.name = "ProviderError";
		this.providerFailure = Object.freeze({ ...providerFailure });
		this.provider = providerFailure.provider;
		this.operation = providerFailure.operation;
		this.kind = providerFailure.kind;
		this.status = providerFailure.status;
		this.code = providerFailure.code;
	}
}

export function providerFailureDetails(error: unknown): ProviderFailureDetails | undefined {
	if (error instanceof ProviderError) return error.providerFailure;
	if (!isObjectRecord(error) || !isProviderFailureDetails(error.providerFailure)) return undefined;
	return { ...error.providerFailure };
}
export function providerFailureDetailsFromStoredFields(value: unknown): ProviderFailureDetails | undefined {
	if (!isObjectRecord(value)) return undefined;
	const candidate = {
		provider: value.error_provider,
		operation: value.provider_operation,
		kind: value.error_kind,
		...(value.error_status === null || value.error_status === undefined ? {} : { status: value.error_status }),
		...(value.error_code === null || value.error_code === undefined ? {} : { code: value.error_code }),
	};
	return isProviderFailureDetails(candidate) ? candidate : undefined;
}

export function providerHttpError(
	message: string,
	provider: ProviderName,
	operation: ProviderOperation,
	status: number,
): ProviderError {
	return new ProviderError(message, { provider, operation, kind: "http", status });
}

export function providerNetworkError(
	error: unknown,
	provider: ProviderName,
	operation: ProviderOperation,
): ProviderError {
	const message = error instanceof Error ? error.message : String(error);
	const code = nestedErrorCode(error);
	return new ProviderError(
		message,
		{ provider, operation, kind: "network", ...(code ? { code } : {}) },
		{ cause: error },
	);
}

export function providerTimeoutError(
	message: string,
	provider: ProviderName,
	operation: ProviderOperation,
	cause?: unknown,
): ProviderError {
	return new ProviderError(
		message,
		{ provider, operation, kind: "timeout" },
		cause === undefined ? undefined : { cause },
	);
}

export function providerCancelledError(
	provider: ProviderName,
	operation: ProviderOperation,
	cause?: unknown,
): ProviderError {
	return new ProviderError(
		"Cancelled",
		{ provider, operation, kind: "cancelled" },
		cause === undefined ? undefined : { cause },
	);
}

export function classifyProviderFailure(details: ProviderFailureDetails): ProviderFailureRetryability {
	if (details.kind === "network" || details.kind === "timeout") return "retryable";
	if (details.kind !== "http" || details.status === undefined) return "unknown";
	if (details.status === 408 || details.status === 425 || details.status === 429 || details.status >= 500) {
		return "retryable";
	}
	if (details.status >= 400 && details.status < 500) return "non_retryable";
	return "unknown";
}

export function providerFailureLabel(details: ProviderFailureDetails): string {
	const parts = [`${details.provider}/${details.operation}`, details.kind];
	if (details.status !== undefined) parts.push(`HTTP ${details.status}`);
	if (details.code) parts.push(details.code);
	parts.push(classifyProviderFailure(details));
	return parts.join(" · ");
}
