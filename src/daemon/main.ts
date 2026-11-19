#!/usr/bin/env node

import { resolveKnowledgeProfile } from "../profiles.ts";
import { ensureDaemonClient, KnowledgeDaemonClient, waitForDaemonShutdown } from "./client.ts";
import { readDaemonManifest } from "./runtime.ts";
import { DaemonStartupCancelledError, ProfileDaemonServer } from "./server.ts";

interface DaemonCliOptions {
	command: "run" | "start" | "status" | "stop";
	profileName?: string;
	expectedProfileId?: string;
	watchersEnabled: boolean;
}

function parseArguments(argv: string[]): DaemonCliOptions {
	const command = argv[0] ?? "run";
	if (command !== "run" && command !== "start" && command !== "status" && command !== "stop") {
		throw new Error(`Unknown daemon command: ${command}`);
	}
	let profileName: string | undefined;
	let expectedProfileId: string | undefined;
	let watchersEnabled = false;
	for (let index = 1; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--watchers") {
			watchersEnabled = true;
			continue;
		}
		if (argument === "--profile" || argument === "--expect-profile-id") {
			const value = argv[index + 1];
			if (!value) throw new Error(`Missing value for ${argument}`);
			if (argument === "--profile") profileName = value;
			else expectedProfileId = value;
			index++;
			continue;
		}
		throw new Error(`Unknown daemon option: ${argument}`);
	}
	return { command, profileName, expectedProfileId, watchersEnabled };
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runForeground(options: DaemonCliOptions): Promise<void> {
	const profile = resolveKnowledgeProfile(options.profileName);
	if (options.expectedProfileId && options.expectedProfileId !== profile.id) {
		throw new Error(
			`Resolved profile identity changed before daemon startup: expected ${options.expectedProfileId}, got ${profile.id}`,
		);
	}
	const server = new ProfileDaemonServer(profile, { watchersEnabled: options.watchersEnabled });
	let terminationRequested = false;
	const stop = (): void => {
		terminationRequested = true;
		void server.shutdown().catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : "Profile daemon shutdown failed");
			process.exit(1);
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const manifest = await server.start();
		if (terminationRequested) {
			await server.shutdown();
			return;
		}
		printJson({
			status: "ready",
			profile: { name: profile.name, id: profile.id },
			pid: manifest.pid,
			watchers_enabled: manifest.watcher_enabled,
		});
		await server.waitUntilStopped();
	} catch (error) {
		if (!(terminationRequested && error instanceof DaemonStartupCancelledError)) throw error;
		await server.shutdown();
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

async function runCommand(options: DaemonCliOptions): Promise<void> {
	if (options.command === "run") {
		await runForeground(options);
		return;
	}
	const profile = resolveKnowledgeProfile(options.profileName);
	if (options.command === "start") {
		const client = await ensureDaemonClient(profile);
		if (options.watchersEnabled) await client.enableWatchers();
		printJson(await client.ping());
		return;
	}
	const manifest = readDaemonManifest(profile);
	if (!manifest) throw new Error(`Knowledge profile daemon is not running: ${profile.name}`);
	const client = new KnowledgeDaemonClient(profile);
	if (options.command === "status") {
		printJson(await client.ping());
		return;
	}
	await client.shutdown();
	await waitForDaemonShutdown(profile, manifest.instance_id);
	printJson({ stopped: true, instance_id: manifest.instance_id });
}

try {
	await runCommand(parseArguments(process.argv.slice(2)));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
