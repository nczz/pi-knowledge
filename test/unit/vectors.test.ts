import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVectors, openVectorReader, openVectorWriter, saveVectors } from "../../src/embedding/vectors.ts";

describe("vector storage", () => {
	it("loads vectors written in multiple append batches", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-vectors-"));
		try {
			const path = join(dir, "vectors.bin");
			const writer = openVectorWriter(path);
			writer.append([new Float32Array([1, 2, 3])]);
			writer.append([new Float32Array([4, 5, 6]), new Float32Array([7, 8, 9])]);
			writer.close();

			const loaded = loadVectors(path);
			expect(loaded).toHaveLength(3);
			expect([...loaded[0]]).toEqual([1, 2, 3]);
			expect([...loaded[2]]).toEqual([7, 8, 9]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps saveVectors compatible with loadVectors", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-vectors-"));
		try {
			const path = join(dir, "vectors.bin");
			saveVectors(path, [new Float32Array([0.25, 0.5])]);

			const loaded = loadVectors(path);
			expect(loaded).toHaveLength(1);
			expect([...loaded[0]]).toEqual([0.25, 0.5]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads individual vectors by index", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-vectors-"));
		try {
			const path = join(dir, "vectors.bin");
			saveVectors(path, [new Float32Array([1, 2]), new Float32Array([3, 4])]);

			const reader = openVectorReader(path);
			try {
				expect(reader?.count).toBe(2);
				expect(reader?.dim).toBe(2);
				expect([...(reader?.read(1) ?? [])]).toEqual([3, 4]);
				expect(reader?.read(2)).toBeUndefined();
			} finally {
				reader?.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
