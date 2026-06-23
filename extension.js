import { existsSync } from "node:fs";

function extensionModule(modulePath) {
	return `./${modulePath}`;
}

const module = existsSync(new URL("./dist/index.js", import.meta.url))
	? await import(extensionModule("dist/index.js"))
	: await import(extensionModule("index.ts"));

export default module.default;
