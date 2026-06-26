import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => ({
	fork: vi.fn(),
}));

vi.mock("node:child_process", () => forkMock);

function createFakeChild(): ChildProcess {
	const child = new EventEmitter() as ChildProcess & {
		connected: boolean;
		stderr: PassThrough;
		send: ChildProcess["send"];
		killed: boolean;
		kill: ChildProcess["kill"];
	};
	child.connected = true;
	child.stderr = new PassThrough();
	child.killed = false;
	child.send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
		callback?.(null);
		return true;
	}) as ChildProcess["send"];
	child.kill = vi.fn(() => {
		child.killed = true;
		return true;
	}) as ChildProcess["kill"];
	return child;
}

describe("model worker client", () => {
	beforeEach(() => {
		vi.resetModules();
		forkMock.fork.mockReset();
	});

	it("includes worker stderr when the model worker exits before responding", async () => {
		const child = createFakeChild();
		forkMock.fork.mockReturnValue(child);
		const { embedInModelWorker } = await import("../../src/model-worker-client.ts");

		const request = embedInModelWorker(["hello"], "passage");
		(child.stderr as PassThrough | null)?.write("native runtime failed to load\n");
		child.emit("exit", 1, null);

		await expect(request).rejects.toThrow(
			"Model worker exited before responding (code 1, signal null). Worker stderr:\nnative runtime failed to load",
		);
	});
});
