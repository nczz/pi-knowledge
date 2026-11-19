import { describe, expect, it } from "vitest";
import { fetchPublicText } from "../../src/network/safe-fetch.ts";

describe("safe URL fetch policy", () => {
	it("rejects loopback and link-local destinations before connecting", async () => {
		await expect(fetchPublicText("http://127.0.0.1/internal")).rejects.toThrow("non-public address");
		await expect(fetchPublicText("http://[::1]/internal")).rejects.toThrow("non-public address");
		await expect(fetchPublicText("http://169.254.169.254/latest/meta-data")).rejects.toThrow("non-public address");
		await expect(fetchPublicText("http://[fec0::1]/internal")).rejects.toThrow("non-public address");
		await expect(fetchPublicText("http://[2002:7f00:1::]/internal")).rejects.toThrow("non-public address");
	});

	it("rejects credentials embedded in source URLs", async () => {
		await expect(fetchPublicText("https://user:secret@example.com/")).rejects.toThrow("credentials are not allowed");
	});
});
