import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface VectorWriter {
	append(vectors: Float32Array[]): void;
	close(): void;
}

export function openVectorWriter(path: string): VectorWriter {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const fd = openSync(path, "w");
	let count = 0;
	let dim = 0;
	let closed = false;
	let byteOffset = 8;
	writeSync(fd, Buffer.alloc(8), 0, 8, 0);

	function writeHeader(): void {
		const header = Buffer.alloc(8);
		header.writeUInt32LE(count, 0);
		header.writeUInt32LE(dim, 4);
		writeSync(fd, header, 0, header.length, 0);
	}

	return {
		append(vectors: Float32Array[]): void {
			if (closed) throw new Error("Vector writer is already closed");
			for (const vector of vectors) {
				if (dim === 0) dim = vector.length;
				if (vector.length !== dim) {
					throw new Error(`Vector dimension mismatch: expected ${dim}, got ${vector.length}`);
				}
				const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
				writeSync(fd, bytes, 0, bytes.length, byteOffset);
				byteOffset += bytes.length;
				count++;
			}
		},
		close(): void {
			if (closed) return;
			writeHeader();
			closeSync(fd);
			closed = true;
		},
	};
}

export function saveVectors(path: string, vectors: Float32Array[]): void {
	const writer = openVectorWriter(path);
	try {
		writer.append(vectors);
	} finally {
		writer.close();
	}
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
