import { randomUUID } from "node:crypto";

export type MutationOperation = "add" | "update" | "remove" | "clear" | "import" | "export";

export interface MutationRequest {
	operation: MutationOperation;
	target?: string;
	keys: readonly string[];
}

export interface ActiveMutationStatus {
	id: string;
	operation: MutationOperation;
	target?: string;
	started_at: number;
}

interface ActiveMutation extends ActiveMutationStatus {
	keys: readonly string[];
	run?: Promise<unknown>;
}

function mutationLabel(mutation: Pick<ActiveMutationStatus, "operation" | "target">): string {
	return mutation.target ? `${mutation.operation} for ${JSON.stringify(mutation.target)}` : mutation.operation;
}

export class MutationBusyError extends Error {
	readonly code = "MUTATION_BUSY";
	readonly requested: Pick<MutationRequest, "operation" | "target">;
	readonly active: ActiveMutationStatus;

	constructor(requested: MutationRequest, active: ActiveMutationStatus) {
		super(`Cannot start ${mutationLabel(requested)}; ${mutationLabel(active)} is already running`);
		this.name = "MutationBusyError";
		this.requested = { operation: requested.operation, ...(requested.target ? { target: requested.target } : {}) };
		this.active = { ...active };
	}
}

export class MutationCoordinator {
	private readonly activeByKey = new Map<string, ActiveMutation>();

	run<T>(request: MutationRequest, operation: () => Promise<T> | T): Promise<T> {
		this.assertAvailable(request);
		const active: ActiveMutation = {
			id: randomUUID(),
			operation: request.operation,
			...(request.target ? { target: request.target } : {}),
			started_at: Date.now(),
			keys: [...request.keys],
		};
		for (const key of active.keys) this.activeByKey.set(key, active);

		const run = (async () => {
			try {
				await Promise.resolve();
				return await operation();
			} finally {
				this.release(active);
			}
		})();
		active.run = run;
		return run;
	}

	assertAvailable(request: MutationRequest): void {
		for (const key of request.keys) {
			const active = this.activeByKey.get(key);
			if (active) throw new MutationBusyError(request, active);
		}
	}

	active(): ActiveMutationStatus[] {
		const unique = new Map<string, ActiveMutationStatus>();
		for (const mutation of this.activeByKey.values()) {
			if (unique.has(mutation.id)) continue;
			unique.set(mutation.id, {
				id: mutation.id,
				operation: mutation.operation,
				...(mutation.target ? { target: mutation.target } : {}),
				started_at: mutation.started_at,
			});
		}
		return [...unique.values()].sort(
			(left, right) => left.started_at - right.started_at || left.id.localeCompare(right.id),
		);
	}

	runs(): Promise<unknown>[] {
		const unique = new Set<Promise<unknown>>();
		for (const mutation of this.activeByKey.values()) {
			if (mutation.run) unique.add(mutation.run);
		}
		return [...unique];
	}

	private release(active: ActiveMutation): void {
		for (const key of active.keys) {
			if (this.activeByKey.get(key) === active) this.activeByKey.delete(key);
		}
	}
}
