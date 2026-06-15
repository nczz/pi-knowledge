import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["test/unit/**/*.test.ts", "test/e2e/**/*.test.ts"] },
});
