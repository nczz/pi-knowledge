import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function saveVectors(path: string, vectors: Float32Array[]): void {
	if (vectors.length === 0) return;
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const dim = vectors[0].length;
	const buffer = Buffer.alloc(8 + vectors.length * dim * 4);
	buffer.writeUInt32LE(vectors.length, 0);
	buffer.writeUInt32LE(dim, 4);
	let offset = 8;
	for (const vec of vectors) {
		Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(buffer, offset);
		offset += dim * 4;
	}
	writeFileSync(path, buffer);
}

export function loadVectors(path: string): Float32Array[] {
	if (!existsSync(path)) return [];
	const buffer = readFileSync(path);
	if (buffer.length < 8) return [];
	const count = buffer.readUInt32LE(0);
	const dim = buffer.readUInt32LE(4);
	const vectors: Float32Array[] = [];
	for (let i = 0; i < count; i++) {
		const offset = 8 + i * dim * 4;
		const vec = new Float32Array(dim);
		for (let j = 0; j < dim; j++) {
			vec[j] = buffer.readFloatLE(offset + j * 4);
		}
		vectors.push(vec);
	}
	return vectors;
}
