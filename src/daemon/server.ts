import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { KnowledgeProfile } from "../profiles.ts";
import { type ProviderFailureDetails, providerFailureDetails } from "../provider-errors.ts";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SHUTDOWN_GRACE_MS,
	DAEMON_SHUTDOWN_SETTLE_MS,
	type DaemonClientFrame,
	type DaemonErrorFrame,
	type DaemonManifest,
	type DaemonServerFrame,
	MAX_PROGRESS_FRAMES,
	MAX_RPC_CONNECTIONS,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_IN_FLIGHT,
	packageBuildIdentity,
	packageVersion,
	parseDaemonClientFrame,
} from "./protocol.ts";
import {
	acquireDaemonOwnership,
	DaemonLockExistsError,
	type DaemonOwnership,
	processIsAlive,
	publishDaemonManifest,
	readDaemonOwner,
	releaseDaemonOwnership,
	removeStaleOwnership,
} from "./runtime.ts";
import { KnowledgeDaemonService } from "./service.ts";

const MAX_RPC_CONTROL_CONNECTIONS = 4;

export class DaemonAlreadyRunningError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonAlreadyRunningError";
	}
}

export class DaemonStartupCancelledError extends Error {
	constructor() {
		super("Profile daemon startup was cancelled by shutdown");
		this.name = "DaemonStartupCancelledError";
	}
}

export interface ProfileDaemonServerOptions {
	watchersEnabled?: boolean;
	failStop?: (message: string) => never;
}

function errorFrame(id: string, code: string, message: string, details?: ProviderFailureDetails): DaemonErrorFrame {
	const boundedMessage = message.length > 4_096 ? `${message.slice(0, 4_096)}…` : message;
	return { type: "error", id, code, message: boundedMessage, ...(details ? { details } : {}) };
}

function endpointAcceptsConnections(endpoint: string, timeoutMs = 500): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = createConnection(endpoint);
	let settled = false;
	const finish = (result: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.destroy();
		resolve(result);
	};
	const timer = setTimeout(() => finish(false), timeoutMs);
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	return promise;
}

function closeServer(server: Server): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	try {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	} catch (error) {
		reject(error);
	}
	return promise;
}

async function acquireWithRecovery(profile: KnowledgeProfile): Promise<DaemonOwnership> {
	try {
		return acquireDaemonOwnership(profile);
	} catch (error) {
		if (!(error instanceof DaemonLockExistsError)) throw error;
	}
	const owner = readDaemonOwner(profile);
	if (!owner) throw new DaemonAlreadyRunningError("Daemon lock exists without a readable owner record");
	if (await endpointAcceptsConnections(owner.endpoint)) {
		throw new DaemonAlreadyRunningError(`Knowledge profile daemon is already listening (PID ${owner.pid})`);
	}
	if (processIsAlive(owner.pid)) {
		throw new DaemonAlreadyRunningError(
			`Knowledge profile daemon PID ${owner.pid} is alive but unresponsive; refusing unsafe takeover`,
		);
	}
	removeStaleOwnership(profile, owner);
	return acquireDaemonOwnership(profile);
}

export class ProfileDaemonServer {
	private readonly controlCandidates = new Set<Socket>();
	private readonly sockets = new Set<Socket>();
	private readonly requestControllers = new Map<string, AbortController>();
	private readonly inFlight = new Set<Promise<void>>();
	private readonly service: KnowledgeDaemonService;
	private readonly failStop: (message: string) => never;
	private readonly profile: KnowledgeProfile;
	private readonly options: ProfileDaemonServerOptions;
	private server: Server | undefined;
	private ownership: DaemonOwnership | undefined;
	private manifest: DaemonManifest | undefined;
	private accepting = false;
	private connectionCount = 0;
	private shutdownPromise: Promise<void> | undefined;
	private startingPromise: Promise<DaemonManifest> | undefined;
	private stopping = false;
	private startFailed = false;
	private controlTrimScheduled = false;
	private readonly stopped = Promise.withResolvers<void>();

	constructor(profile: KnowledgeProfile, options: ProfileDaemonServerOptions = {}) {
		this.profile = profile;
		this.options = options;
		this.service = new KnowledgeDaemonService(profile, undefined, () => {
			this.refreshManifestDiagnostics(this.manifest?.watcher_enabled ?? this.options.watchersEnabled === true);
		});
		this.failStop =
			options.failStop ??
			((message) => {
				console.error(message);
				process.exit(1);
			});
	}

	start(): Promise<DaemonManifest> {
		if (this.startFailed) return Promise.reject(new Error("Profile daemon server cannot restart after failed startup"));
		if (this.startingPromise || this.server || this.ownership) {
			return Promise.reject(new Error("Profile daemon server is already started"));
		}
		if (this.stopping) return Promise.reject(new Error("Profile daemon server is stopping"));
		const run = this.startInternal();
		this.startingPromise = run;
		const clearStarting = (): void => {
			if (this.startingPromise === run) this.startingPromise = undefined;
		};
		void run.then(clearStarting, clearStarting);
		return run;
	}

	private assertStartupActive(): void {
		if (this.stopping) throw new DaemonStartupCancelledError();
	}

	private async startInternal(): Promise<DaemonManifest> {
		let ownership: DaemonOwnership | undefined;
		let boundEndpoint = false;
		let server: Server | undefined;
		try {
			ownership = await acquireWithRecovery(this.profile);
			this.assertStartupActive();
			this.ownership = ownership;
			server = createServer((socket) => this.acceptConnection(socket));
			this.server = server;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const onError = (error: Error): void => {
				server?.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server?.off("error", onError);
				boundEndpoint = true;
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(ownership.owner.endpoint);
			await promise;
			this.assertStartupActive();
			this.manifest = publishDaemonManifest(this.profile, ownership, {
				ready: false,
				watcherEnabled: false,
			});
			this.assertStartupActive();
			process.env.PI_KNOWLEDGE_DIR = this.profile.storageDir;
			await this.service.initialize(this.options.watchersEnabled === true);
			this.assertStartupActive();
			this.accepting = true;
			this.manifest = publishDaemonManifest(this.profile, ownership, {
				ready: true,
				watcherEnabled: this.options.watchersEnabled === true,
				lastSnapshotError: this.service.coverageSnapshotError(),
			});
			return this.manifest;
		} catch (error) {
			this.startFailed = true;
			this.accepting = false;
			this.service.abortOperations();
			for (const socket of this.sockets) socket.destroy();
			let cleanupError: unknown;
			try {
				if (server?.listening) await closeServer(server);
			} catch (candidate) {
				cleanupError = candidate;
			}
			try {
				await this.service.dispose();
			} catch (candidate) {
				cleanupError ??= candidate;
			}
			if (cleanupError) {
				this.failStop(
					`Profile daemon startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
			if (ownership) releaseDaemonOwnership(this.profile, ownership, { removeEndpoint: boundEndpoint });
			this.ownership = undefined;
			this.server = undefined;
			this.manifest = undefined;
			throw error;
		}
	}

	private writeFrame(socket: Socket, frame: DaemonServerFrame): boolean {
		let line = `${JSON.stringify(frame)}\n`;
		let bytes = Buffer.byteLength(line);
		if (bytes > MAX_RPC_FRAME_BYTES) {
			if (frame.type !== "result") {
				socket.destroy(new Error("Daemon response exceeds the configured frame limit"));
				return false;
			}
			line = `${JSON.stringify(
				errorFrame(frame.id, "response_too_large", "Daemon result exceeds the configured response limit"),
			)}\n`;
			bytes = Buffer.byteLength(line);
		}
		if (socket.writableLength + bytes > MAX_RPC_FRAME_BYTES) {
			socket.destroy(new Error("Daemon outbound buffer exceeds the configured limit"));
			return false;
		}
		return socket.write(line);
	}

	private scheduleControlCandidateTrim(): void {
		if (this.controlTrimScheduled) return;
		this.controlTrimScheduled = true;
		setImmediate(() => {
			this.controlTrimScheduled = false;
			while (this.controlCandidates.size > MAX_RPC_CONTROL_CONNECTIONS) {
				const oldest = this.controlCandidates.values().next().value;
				if (!oldest) break;
				this.controlCandidates.delete(oldest);
				if (this.sockets.delete(oldest)) this.connectionCount--;
				oldest.destroy(new Error("Reserved daemon control connection was superseded"));
			}
		});
	}

	private acceptConnection(socket: Socket): void {
		socket.on("error", () => {
			/* connection-local framing and peer errors must not terminate the daemon */
		});
		this.connectionCount++;
		this.sockets.add(socket);
		const controlOnly = this.connectionCount > MAX_RPC_CONNECTIONS;
		let inputBuffer: Buffer | undefined;
		let inputBytes = 0;
		let requestId: string | undefined;
		const requestKey = randomUUID();
		let progressFrames = 0;
		const authenticationDeadline = setTimeout(() => socket.destroy(), 5_000);
		authenticationDeadline.unref();
		const close = (): void => {
			if (!this.sockets.delete(socket)) return;
			clearTimeout(authenticationDeadline);
			this.requestControllers.get(requestKey)?.abort();
			this.controlCandidates.delete(socket);
			this.connectionCount--;
		};
		socket.once("close", close);
		if (controlOnly) {
			this.controlCandidates.add(socket);
			this.scheduleControlCandidateTrim();
		}
		const acceptLine = (lineBuffer: Buffer): void => {
			const line = lineBuffer.toString("utf8").trim();
			if (!line) return;
			try {
				const frame = parseDaemonClientFrame(JSON.parse(line));
				if (frame.type === "cancel") {
					if (requestId === frame.id && this.manifest && frame.token === this.manifest.auth_token) {
						this.requestControllers.get(requestKey)?.abort();
					}
				} else if (requestId) {
					this.writeFrame(socket, errorFrame(frame.id, "invalid_request", "One request is allowed per connection"));
				} else {
					clearTimeout(authenticationDeadline);
					requestId = frame.id;
					if (
						controlOnly &&
						frame.type === "request" &&
						frame.method === "shutdown" &&
						this.manifest &&
						frame.token === this.manifest.auth_token
					) {
						this.controlCandidates.delete(socket);
					}
					const run = this.handleRequest(socket, requestKey, frame, controlOnly, () => {
						progressFrames++;
						return progressFrames <= MAX_PROGRESS_FRAMES;
					});
					this.inFlight.add(run);
					void run.finally(() => this.inFlight.delete(run));
				}
			} catch (error) {
				this.writeFrame(
					socket,
					errorFrame(requestId ?? "", "invalid_request", error instanceof Error ? error.message : "Invalid request"),
				);
				socket.end();
			}
		};
		socket.on("data", (chunk: Buffer) => {
			let offset = 0;
			while (offset < chunk.byteLength) {
				const newline = chunk.indexOf(0x0a, offset);
				const end = newline < 0 ? chunk.byteLength : newline;
				const part = chunk.subarray(offset, end);
				const requiredBytes = inputBytes + part.byteLength;
				if (requiredBytes > MAX_RPC_FRAME_BYTES) {
					socket.destroy(new Error("Daemon request exceeds the configured frame limit"));
					return;
				}
				if (part.byteLength > 0) {
					if (!inputBuffer || inputBuffer.byteLength < requiredBytes) {
						const capacity = Math.min(
							MAX_RPC_FRAME_BYTES,
							Math.max(requiredBytes, inputBuffer ? inputBuffer.byteLength * 2 : 4_096),
						);
						const grown = Buffer.allocUnsafe(capacity);
						inputBuffer?.copy(grown, 0, 0, inputBytes);
						inputBuffer = grown;
					}
					part.copy(inputBuffer, inputBytes);
					inputBytes = requiredBytes;
				}
				if (newline < 0) return;
				if (inputBuffer && inputBytes > 0) acceptLine(inputBuffer.subarray(0, inputBytes));
				inputBuffer = undefined;
				inputBytes = 0;
				offset = newline + 1;
			}
		});
	}

	private refreshManifestDiagnostics(watchersEnabled: boolean): void {
		if (!this.ownership || !this.manifest) return;
		const snapshotError = this.service.coverageSnapshotError();
		if (this.manifest.watcher_enabled === watchersEnabled && this.manifest.last_snapshot_error === snapshotError) {
			return;
		}
		try {
			this.manifest = publishDaemonManifest(this.profile, this.ownership, {
				ready: this.accepting,
				watcherEnabled: watchersEnabled,
				lastSnapshotError: snapshotError,
			});
		} catch {
			console.error("Failed to publish daemon runtime diagnostics");
		}
	}

	private async handleRequest(
		socket: Socket,
		requestKey: string,
		frame: Extract<DaemonClientFrame, { type: "request" }>,
		controlOnly: boolean,
		allowProgress: () => boolean,
	): Promise<void> {
		const manifest = this.manifest;
		if (!manifest || frame.token !== manifest.auth_token) {
			this.writeFrame(socket, errorFrame(frame.id, "unauthorized", "Invalid daemon credential"));
			socket.end();
			return;
		}
		if (frame.method === "shutdown") {
			this.writeFrame(socket, { type: "result", id: frame.id, result: { accepted: true } });
			socket.end();
			void this.shutdown().catch((error: unknown) =>
				this.failStop(error instanceof Error ? error.message : "Profile daemon shutdown failed"),
			);
			return;
		}
		if (frame.package_version !== packageVersion()) {
			this.writeFrame(socket, errorFrame(frame.id, "version_mismatch", "Daemon and client package versions differ"));
			socket.end();
			return;
		}
		if (frame.build_identity !== packageBuildIdentity()) {
			this.writeFrame(socket, errorFrame(frame.id, "build_mismatch", "Daemon and client builds differ"));
			socket.end();
			return;
		}
		if (controlOnly) {
			this.writeFrame(socket, errorFrame(frame.id, "overloaded", "Normal daemon connection capacity is exhausted"));
			socket.end();
			return;
		}
		if (frame.method === "ping") {
			this.writeFrame(socket, {
				type: "result",
				id: frame.id,
				result: {
					ready: manifest.ready && this.accepting,
					protocol_version: DAEMON_PROTOCOL_VERSION,
					profile: { name: this.profile.name, id: this.profile.id },
					storage_dir: this.profile.storageDir,
					instance_id: manifest.instance_id,
					pid: manifest.pid,
					package_version: manifest.package_version,
					runtime_configuration_signature: manifest.runtime_configuration_signature,
					build_identity: manifest.build_identity,
				},
			});
			socket.end();
			return;
		}
		if (!this.accepting || !manifest.ready) {
			this.writeFrame(socket, errorFrame(frame.id, "not_ready", "Knowledge profile daemon is initializing"));
			socket.end();
			return;
		}
		if (this.inFlight.size >= MAX_RPC_IN_FLIGHT) {
			this.writeFrame(socket, errorFrame(frame.id, "overloaded", "Too many in-flight daemon requests"));
			socket.end();
			return;
		}
		const controller = new AbortController();
		this.requestControllers.set(requestKey, controller);
		try {
			const result = await this.service.dispatch(frame.method, frame.params, {
				requestId: requestKey,
				signal: controller.signal,
				onProgress: (message) => {
					if (allowProgress()) this.writeFrame(socket, { type: "progress", id: frame.id, message });
				},
			});
			const watchersEnabled = frame.method === "enable_watchers" || this.manifest?.watcher_enabled === true;
			this.refreshManifestDiagnostics(watchersEnabled);
			if (!controller.signal.aborted) this.writeFrame(socket, { type: "result", id: frame.id, result });
		} catch (error) {
			if (!controller.signal.aborted) {
				this.writeFrame(
					socket,
					errorFrame(
						frame.id,
						"operation_failed",
						error instanceof Error ? error.message : String(error),
						providerFailureDetails(error),
					),
				);
			}
		} finally {
			this.requestControllers.delete(requestKey);
			socket.end();
		}
	}

	private async waitForQuiescence(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.inFlight.size > 0 || this.service.activeUpdateCount() > 0) {
			if (Date.now() >= deadline) return false;
			await delay(20);
		}
		return true;
	}

	waitUntilStopped(): Promise<void> {
		return this.stopped.promise;
	}
	private publishStoppingState(): void {
		if (!this.ownership) return;
		try {
			this.manifest = publishDaemonManifest(this.profile, this.ownership, {
				ready: false,
				watcherEnabled: this.manifest?.watcher_enabled === true,
				lastSnapshotError: this.service.coverageSnapshotError(),
			});
		} catch (error) {
			console.error(
				`Failed to publish daemon shutdown state: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopping = true;
		this.accepting = false;
		if (this.manifest) this.manifest = { ...this.manifest, ready: false };
		const ownershipAtShutdown = this.ownership;
		this.publishStoppingState();
		for (const controller of this.requestControllers.values()) controller.abort();
		this.service.abortOperations();
		const startup = this.startingPromise;
		this.shutdownPromise = (async () => {
			await startup?.catch(() => {});
			if (!this.server && !this.ownership) {
				this.stopped.resolve();
				return;
			}
			if (this.ownership !== ownershipAtShutdown) this.publishStoppingState();
			const serverClosed = this.server?.listening ? closeServer(this.server) : Promise.resolve();
			const quiesced = await this.waitForQuiescence(DAEMON_SHUTDOWN_GRACE_MS);
			if (!quiesced) {
				this.service.forceTerminateModelWorker();
				const settled = await this.waitForQuiescence(DAEMON_SHUTDOWN_SETTLE_MS);
				if (!settled) this.failStop("Profile daemon could not safely settle active operations during shutdown");
			}
			await this.service.dispose();
			for (const socket of this.sockets) socket.destroy();
			await serverClosed;
			if (this.ownership) releaseDaemonOwnership(this.profile, this.ownership);
			this.server = undefined;
			this.ownership = undefined;
			this.manifest = undefined;
			this.stopped.resolve();
		})();
		return this.shutdownPromise;
	}
}
