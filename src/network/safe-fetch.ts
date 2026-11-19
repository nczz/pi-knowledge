import { lookup } from "node:dns/promises";
import type { ClientRequest } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

interface SafeFetchOptions {
	maxBytes?: number;
	timeoutMs?: number;
	maxRedirects?: number;
}

function isPublicIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return false;
	}
	const [first = 0, second = 0, third = 0] = octets;
	if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
	if (first === 100 && second >= 64 && second <= 127) return false;
	if (first === 169 && second === 254) return false;
	if (first === 172 && second >= 16 && second <= 31) return false;
	if (first === 192 && (second === 0 || second === 168)) return false;
	if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) return false;
	if (first === 203 && second === 0 && third === 113) return false;
	return true;
}

function isPublicIpv6(address: string): boolean {
	const normalized = address.toLowerCase().split("%")[0] ?? "";
	if (!normalized || normalized === "::" || normalized === "::1") return false;
	if (normalized.startsWith("::ffff:")) return isPublicIpv4(normalized.slice("::ffff:".length));
	const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
	if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return false;
	if (
		normalized.startsWith("2001:0:") ||
		normalized.startsWith("2001:2:") ||
		normalized.startsWith("2001:10:") ||
		normalized.startsWith("2001:db8:") ||
		normalized.startsWith("2002:")
	) {
		return false;
	}
	return true;
}

function assertPublicAddress(address: string): void {
	const family = isIP(address);
	const allowed = family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
	if (!allowed) throw new Error(`URL host resolved to a non-public address: ${address}`);
}

function remainingTime(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("URL fetch timed out");
	return remaining;
}

function withDeadline<T>(operation: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const finish = (error?: Error, value?: T): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		if (error) reject(error);
		else resolve(value as T);
	};
	const abort = (): void => finish(new Error("Cancelled"));
	const timeout = setTimeout(() => finish(new Error("URL fetch timed out")), remainingTime(deadline));
	timeout.unref();
	signal?.addEventListener("abort", abort, { once: true });
	void operation.then(
		(value) => finish(undefined, value),
		(error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
	);
	return promise;
}

async function resolvePublicAddress(
	hostname: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
	if (isIP(hostname)) {
		assertPublicAddress(hostname);
		return { address: hostname, family: isIP(hostname) as 4 | 6 };
	}
	const addresses = await withDeadline(lookup(hostname, { all: true, verbatim: true }), deadline, signal);
	if (addresses.length === 0) throw new Error(`URL host did not resolve: ${hostname}`);
	for (const candidate of addresses) assertPublicAddress(candidate.address);
	const selected = addresses[0];
	if (!selected || (selected.family !== 4 && selected.family !== 6)) {
		throw new Error(`URL host did not resolve to IPv4 or IPv6: ${hostname}`);
	}
	return { address: selected.address, family: selected.family };
}

async function requestText(
	url: URL,
	signal: AbortSignal | undefined,
	maxBytes: number,
	deadline: number,
): Promise<{ location?: string; body: string; bytes: number }> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	}
	if (url.username || url.password) throw new Error("URL credentials are not allowed");
	if (signal?.aborted) throw new Error("Cancelled");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const target = await resolvePublicAddress(hostname, deadline, signal);
	if (signal?.aborted) throw new Error("Cancelled");

	const { promise, resolve, reject } = Promise.withResolvers<{ location?: string; body: string; bytes: number }>();
	let request: ClientRequest;
	let settled = false;
	const finish = (error?: Error, result?: { location?: string; body: string; bytes: number }): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		if (error) reject(error);
		else resolve(result as { location?: string; body: string; bytes: number });
	};
	const abort = (): void => {
		request.destroy();
		finish(new Error("Cancelled"));
	};
	const timeout = setTimeout(() => {
		request.destroy();
		finish(new Error("URL fetch timed out"));
	}, remainingTime(deadline));
	timeout.unref();

	const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
	request = transport(
		{
			protocol: url.protocol,
			hostname: target.address,
			family: target.family,
			port: url.port || undefined,
			path: `${url.pathname}${url.search}`,
			method: "GET",
			headers: { Accept: "text/html, text/plain;q=0.9", Host: url.host },
			servername: url.protocol === "https:" ? hostname : undefined,
		},
		(response) => {
			response.once("error", (error) => finish(error));
			const statusCode = response.statusCode ?? 0;
			const location = response.headers.location;
			if (statusCode >= 300 && statusCode < 400 && location) {
				response.destroy();
				finish(undefined, { location, body: "", bytes: 0 });
				return;
			}
			if (statusCode < 200 || statusCode >= 300) {
				response.destroy();
				finish(new Error(`Fetch failed: ${statusCode}`));
				return;
			}
			const declaredLength = Number(response.headers["content-length"]);
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
				response.destroy();
				finish(new Error(`URL response exceeds ${maxBytes} bytes`));
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > maxBytes) {
					response.destroy();
					finish(new Error(`URL response exceeds ${maxBytes} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			response.once("end", () => finish(undefined, { body: Buffer.concat(chunks, bytes).toString("utf8"), bytes }));
		},
	);
	signal?.addEventListener("abort", abort, { once: true });
	request.once("error", (error) => finish(error));
	request.end();
	return promise;
}

export async function fetchPublicText(
	source: string,
	signal?: AbortSignal,
	options: SafeFetchOptions = {},
): Promise<string> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const deadline = Date.now() + timeoutMs;
	let remainingBytes = maxBytes;
	let current = new URL(source);
	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const response = await requestText(current, signal, remainingBytes, deadline);
		remainingBytes -= response.bytes;
		if (!response.location) return response.body;
		if (redirects === maxRedirects) throw new Error(`URL exceeded ${maxRedirects} redirects`);
		current = new URL(response.location, current);
	}
	throw new Error("URL redirect handling failed");
}
