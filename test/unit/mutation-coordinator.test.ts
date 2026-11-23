import { describe, expect, it } from "vitest";
import { MutationBusyError, MutationCoordinator } from "../../src/mutation-coordinator.ts";

describe("MutationCoordinator", () => {
	it("reports the actual owner and releases every key when the operation settles", async () => {
		const coordinator = new MutationCoordinator();
		const deferred = Promise.withResolvers<string>();
		const first = coordinator.run(
			{ keys: ["global:mutation", "kb:first"], operation: "update", target: "First KB" },
			() => deferred.promise,
		);

		expect(coordinator.active()).toMatchObject([
			{ operation: "update", target: "First KB", started_at: expect.any(Number) },
		]);
		expect(() =>
			coordinator.run(
				{ keys: ["global:mutation", "kb:second"], operation: "update", target: "Second KB" },
				async () => "second",
			),
		).toThrowError(
			expect.objectContaining({
				name: "MutationBusyError",
				message: 'Cannot start update for "Second KB"; update for "First KB" is already running',
				code: "MUTATION_BUSY",
				active: expect.objectContaining({ operation: "update", target: "First KB" }),
			}),
		);

		deferred.resolve("first");
		await expect(first).resolves.toBe("first");
		expect(coordinator.active()).toEqual([]);
		await expect(
			coordinator.run(
				{ keys: ["global:mutation", "kb:second"], operation: "update", target: "Second KB" },
				async () => "second",
			),
		).resolves.toBe("second");
	});

	it("releases ownership before propagating an operation failure", async () => {
		const coordinator = new MutationCoordinator();
		const failure = new Error("provider unavailable");

		await expect(
			coordinator.run({ keys: ["global:mutation", "kb:first"], operation: "update", target: "First KB" }, () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(coordinator.active()).toEqual([]);
		expect(coordinator.runs()).toEqual([]);
		expect(() =>
			coordinator.assertAvailable({ keys: ["global:mutation"], operation: "remove", target: "First KB" }),
		).not.toThrow();
	});

	it("keeps an unsettled operation locked instead of expiring ownership unsafely", async () => {
		const coordinator = new MutationCoordinator();
		const deferred = Promise.withResolvers<void>();
		const run = coordinator.run(
			{ keys: ["global:mutation"], operation: "export", target: "Archive" },
			() => deferred.promise,
		);

		expect(() => coordinator.assertAvailable({ keys: ["global:mutation"], operation: "clear" })).toThrow(
			MutationBusyError,
		);
		deferred.resolve();
		await run;
		expect(coordinator.active()).toEqual([]);
	});
});
