import { existsSync } from "node:fs";

const module = existsSync(new URL("./dist/index.js", import.meta.url))
	? await import("./dist/index.js")
	: await import("./index.ts");

export default module.default;
