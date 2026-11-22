import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPrivateJson, writeJsonAtomic } from "./secure-files.ts";
import { getDefaultKnowledgeDir } from "./storage/sqlite.ts";

export type RuntimeConfig = {
	node_path?: string;
	updated_at?: number;
};

const CONFIG_FILE = "config.json";

function runtimeConfigPath(knowledgeDir = getDefaultKnowledgeDir()): string {
	return join(knowledgeDir, CONFIG_FILE);
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
	if (typeof value !== "object" || value === null) return false;
	if ("node_path" in value && value.node_path !== undefined && typeof value.node_path !== "string") return false;
	return !("updated_at" in value) || value.updated_at === undefined || typeof value.updated_at === "number";
}

export function readRuntimeConfig(knowledgeDir = getDefaultKnowledgeDir()): RuntimeConfig {
	const configPath = runtimeConfigPath(knowledgeDir);
	if (!existsSync(configPath)) return {};
	const parsed = readPrivateJson(configPath, "pi-knowledge runtime config", { harden: true });
	if (!isRuntimeConfig(parsed)) throw new Error(`Invalid pi-knowledge runtime config: ${configPath}`);
	return parsed;
}

export function getConfiguredNodePath(): string | undefined {
	return readRuntimeConfig().node_path?.trim() || undefined;
}

export function writeRuntimeConfig(update: RuntimeConfig, knowledgeDir = getDefaultKnowledgeDir()): RuntimeConfig {
	const existing = readRuntimeConfig(knowledgeDir);
	const next: RuntimeConfig = { ...existing, ...update, updated_at: Date.now() };
	const configPath = runtimeConfigPath(knowledgeDir);
	writeJsonAtomic(configPath, next);
	return next;
}
