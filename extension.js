import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distUrl = new URL("./dist/index.js", import.meta.url);
const sourceUrl = new URL("./index.ts", import.meta.url);
const entryUrl = existsSync(fileURLToPath(distUrl)) ? distUrl : sourceUrl;
const module = await import(entryUrl.href);

export default module.default;
