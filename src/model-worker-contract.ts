export const MAX_EXTRACTED_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_WORKER_STDIO_FRAME_BYTES = 64 * 1024 * 1024;

export function assertExtractedDocumentSize(content: string): void {
	const bytes = Buffer.byteLength(content);
	if (bytes > MAX_EXTRACTED_DOCUMENT_BYTES) {
		throw new Error(`Extracted document exceeds the ${MAX_EXTRACTED_DOCUMENT_BYTES}-byte text limit`);
	}
}
