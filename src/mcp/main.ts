#!/usr/bin/env node

import { ensureDaemonClient } from "../daemon/client.ts";
import { packageVersion } from "../daemon/protocol.ts";
import { resolveKnowledgeProfile } from "../profiles.ts";
import { McpHttpServer } from "./http.ts";
import { canonicalizeAllowedRoots, McpStdioAdapter, parseMcpArguments } from "./server.ts";

async function run(): Promise<void> {
	const cli = parseMcpArguments(process.argv.slice(2));
	if (cli.profileName) process.env.PI_KNOWLEDGE_PROFILE = cli.profileName;
	const profile = resolveKnowledgeProfile(cli.profileName);
	const authToken = cli.transport === "http" ? process.env.PI_KNOWLEDGE_MCP_HTTP_TOKEN : undefined;
	if (cli.transport === "http" && authToken === undefined) {
		throw new Error("PI_KNOWLEDGE_MCP_HTTP_TOKEN is required for --transport http");
	}
	const allowRoots = canonicalizeAllowedRoots(cli.allowRoots);
	const client = await ensureDaemonClient(profile);
	const extensionUrl = new URL(import.meta.url.endsWith(".ts") ? "../../index.ts" : "../../index.js", import.meta.url);
	const { getKnowledgeToolDefinitions } = await import(extensionUrl.href);
	const tools = getKnowledgeToolDefinitions();
	if (cli.transport === "stdio") {
		const adapter = new McpStdioAdapter({
			...cli,
			allowRoots,
			profile,
			client,
			tools,
			input: process.stdin,
			output: process.stdout,
			error: process.stderr,
			serverVersion: packageVersion(),
		});
		const stop = (): void => {
			process.stdin.destroy();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			await adapter.run();
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
		return;
	}

	if (authToken === undefined) {
		throw new Error("PI_KNOWLEDGE_MCP_HTTP_TOKEN is required for --transport http");
	}
	const server = new McpHttpServer({
		profile,
		client,
		tools,
		serverVersion: packageVersion(),
		allowRoots,
		allowNetwork: cli.allowNetwork,
		allowWrite: cli.allowWrite,
		allowAdmin: cli.allowAdmin,
		host: cli.httpHost,
		port: cli.httpPort,
		endpoint: cli.httpEndpoint,
		allowedOrigins: cli.allowOrigins,
		authToken,
	});
	const stop = (): void => {
		void server.close().catch((error: unknown) => {
			process.stderr.write(`MCP HTTP shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const address = await server.start();
		process.stderr.write(`pi-knowledge MCP HTTP listening at ${address.url}\n`);
		await server.waitUntilClosed();
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await server.close();
	}
}

try {
	await run();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
