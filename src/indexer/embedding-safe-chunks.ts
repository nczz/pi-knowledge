import type { EmbeddingConfig, EmbeddingInputMeasurement } from "../embedding/provider.ts";
import { measureEmbeddingInputs } from "../embedding/provider.ts";
import type { ChunkInsert } from "../storage/sqlite.ts";
import { buildChunkEmbeddingText, chunkIdentityHash, preTokenizeForFTS } from "./chunker.ts";

type IndexableChunk = Omit<ChunkInsert, "kb_id">;

type PendingPiece = {
	chunk: IndexableChunk;
	rootIndex: number;
	order: number[];
};

const SENTENCE_BOUNDARIES: Record<string, true> = {
	"。": true,
	"！": true,
	"？": true,
	".": true,
	"!": true,
	"?": true,
	";": true,
	"；": true,
};

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}

function compareOrder(left: PendingPiece, right: PendingPiece): number {
	if (left.rootIndex !== right.rootIndex) return left.rootIndex - right.rootIndex;
	const length = Math.min(left.order.length, right.order.length);
	for (let index = 0; index < length; index++) {
		if (left.order[index] !== right.order[index]) return left.order[index] - right.order[index];
	}
	return left.order.length - right.order.length;
}

function nearestStringBoundary(
	content: string,
	desired: number,
	boundary: string,
	minimum: number,
): number | undefined {
	const before = content.lastIndexOf(boundary, desired);
	if (before >= minimum) return before + boundary.length;
	const after = content.indexOf(boundary, desired);
	if (after >= 0 && after <= content.length - minimum) return after + boundary.length;
	return undefined;
}

function nearestCharacterBoundary(
	content: string,
	desired: number,
	minimum: number,
	predicate: (character: string) => boolean,
): number | undefined {
	for (let offset = 0; offset < content.length; offset++) {
		const before = desired - offset;
		if (before >= minimum && predicate(content[before])) return before + 1;
		const after = desired + offset;
		if (after < content.length - minimum && predicate(content[after])) return after + 1;
		if (before < minimum && after >= content.length - minimum) break;
	}
	return undefined;
}

function safeCodeUnitBoundary(content: string, index: number): number {
	if (index <= 0 || index >= content.length) return index;
	const previous = content.charCodeAt(index - 1);
	const next = content.charCodeAt(index);
	return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? index - 1 : index;
}

function chooseSplitIndex(content: string, units: number, measurement: EmbeddingInputMeasurement): number {
	const estimatedParts = Math.max(2, Math.ceil(units / measurement.preferredMaximum));
	const desired = Math.max(1, Math.floor(content.length / estimatedParts));
	const minimum = Math.max(1, Math.min(64, Math.floor(content.length * 0.1)));
	const structuralBoundary =
		nearestStringBoundary(content, desired, "\n\n", minimum) ??
		nearestStringBoundary(content, desired, "\n", minimum) ??
		nearestCharacterBoundary(content, desired, minimum, (character) => SENTENCE_BOUNDARIES[character] === true) ??
		nearestCharacterBoundary(content, desired, minimum, (character) => /\s/u.test(character));
	const splitIndex = safeCodeUnitBoundary(content, structuralBoundary ?? desired);
	if (splitIndex <= 0 || splitIndex >= content.length) {
		throw new Error(`Unable to split oversized embedding input containing ${content.length} characters`);
	}
	return splitIndex;
}

function lineCount(content: string): number {
	let count = 0;
	for (const character of content) {
		if (character === "\n") count++;
	}
	return count;
}

function rebuildChunk(chunk: IndexableChunk, content: string, startLine: number, endLine: number): IndexableChunk {
	const rebuilt = {
		...chunk,
		content,
		content_hash: chunkIdentityHash({
			content,
			filePath: chunk.file_path,
			fileType: chunk.file_type,
			startLine,
			endLine,
			metadataJson: chunk.metadata_json,
		}),
		content_tokenized: "",
		start_line: startLine,
		end_line: endLine,
	};
	return { ...rebuilt, content_tokenized: preTokenizeForFTS(buildChunkEmbeddingText(rebuilt)) };
}

function unsplittableEmbeddingContext(piece: PendingPiece, measurement: EmbeddingInputMeasurement): Error {
	return new Error(
		`Embedding context for ${piece.chunk.file_path}:${piece.chunk.start_line}-${piece.chunk.end_line} exceeds ${measurement.maximum} ${measurement.unit} and cannot be split safely`,
	);
}

function splitPiece(piece: PendingPiece, units: number, measurement: EmbeddingInputMeasurement): PendingPiece[] {
	const content = piece.chunk.content;
	if ([...content].length < 2) throw unsplittableEmbeddingContext(piece, measurement);
	const splitIndex = chooseSplitIndex(content, units, measurement);
	const leftRaw = content.slice(0, splitIndex);
	const rightRaw = content.slice(splitIndex);
	const left = leftRaw.trim();
	const right = rightRaw.trim();
	if (!left || !right || left === content || right === content) {
		throw unsplittableEmbeddingContext(piece, measurement);
	}
	const leftLeadingLines = lineCount(leftRaw.slice(0, leftRaw.indexOf(left)));
	const rightLeadingLines = lineCount(rightRaw.slice(0, rightRaw.indexOf(right)));
	const leftStart = piece.chunk.start_line + leftLeadingLines;
	const leftEnd = leftStart + lineCount(left);
	const rightStart = piece.chunk.start_line + lineCount(leftRaw) + rightLeadingLines;
	const rightEnd = rightStart + lineCount(right);
	return [
		{
			chunk: rebuildChunk(piece.chunk, left, leftStart, leftEnd),
			rootIndex: piece.rootIndex,
			order: [...piece.order, 0],
		},
		{
			chunk: rebuildChunk(piece.chunk, right, rightStart, rightEnd),
			rootIndex: piece.rootIndex,
			order: [...piece.order, 1],
		},
	];
}

function withPartMetadata(chunk: IndexableChunk, part: number, partCount: number): IndexableChunk {
	let metadata: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(chunk.metadata_json) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
	} catch {
		metadata = {};
	}
	const metadataJson = JSON.stringify({ ...metadata, chunk_part: part, chunk_part_count: partCount });
	const rebuilt = { ...chunk, metadata_json: metadataJson, content_tokenized: "" };
	rebuilt.content_hash = chunkIdentityHash({
		content: rebuilt.content,
		filePath: rebuilt.file_path,
		fileType: rebuilt.file_type,
		startLine: rebuilt.start_line,
		endLine: rebuilt.end_line,
		metadataJson,
	});
	rebuilt.content_tokenized = preTokenizeForFTS(buildChunkEmbeddingText(rebuilt));
	return rebuilt;
}

export async function finalizeChunksForEmbedding(
	chunks: IndexableChunk[],
	config: EmbeddingConfig,
	signal?: AbortSignal,
): Promise<IndexableChunk[]> {
	if (chunks.length === 0) return [];
	let pending: PendingPiece[] = chunks.map((chunk, rootIndex) => ({ chunk, rootIndex, order: [] }));
	const accepted: PendingPiece[] = [];
	while (pending.length > 0) {
		throwIfAborted(signal);
		const texts = pending.map((piece) => buildChunkEmbeddingText(piece.chunk));
		const measurement = await measureEmbeddingInputs(texts, "passage", config, signal);
		if (measurement.counts.length !== pending.length) {
			throw new Error(
				`Embedding input measurement returned ${measurement.counts.length} counts for ${pending.length} chunks`,
			);
		}
		const next: PendingPiece[] = [];
		for (let index = 0; index < pending.length; index++) {
			const piece = pending[index];
			const units = measurement.counts[index];
			if (units === undefined) throw new Error(`Missing embedding input measurement for chunk ${index}`);
			if (units <= measurement.maximum) accepted.push(piece);
			else next.push(...splitPiece(piece, units, measurement));
		}
		pending = next;
	}

	accepted.sort(compareOrder);
	const partCounts = new Map<number, number>();
	for (const piece of accepted) partCounts.set(piece.rootIndex, (partCounts.get(piece.rootIndex) ?? 0) + 1);
	const partIndexes = new Map<number, number>();
	return accepted.map((piece) => {
		const partCount = partCounts.get(piece.rootIndex) ?? 1;
		if (partCount === 1) return piece.chunk;
		const part = (partIndexes.get(piece.rootIndex) ?? 0) + 1;
		partIndexes.set(piece.rootIndex, part);
		return withPartMetadata(piece.chunk, part, partCount);
	});
}
