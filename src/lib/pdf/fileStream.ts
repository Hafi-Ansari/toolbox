// Random-access reader MuPDF pulls from synchronously. Inputs are never fully
// loaded into memory: MuPDF asks for byte ranges and we serve them from a small
// LRU cache of 1 MB blocks, filled from a File (worker) or a file descriptor (Node).

export interface StreamHandle {
	fileSize(): number;
	read(memory: Uint8Array, offset: number, length: number, position: number): number;
	close(): void;
}

export type ReadAt = (position: number, length: number) => Uint8Array;

export function blockCachedHandle(
	size: number,
	readAt: ReadAt,
	onClose: () => void = () => {},
	blockSize = 1 << 20,
	maxBlocks = 48,
): StreamHandle {
	const cache = new Map<number, Uint8Array>();

	const block = (index: number): Uint8Array => {
		const hit = cache.get(index);
		if (hit) {
			cache.delete(index);
			cache.set(index, hit);
			return hit;
		}
		const start = index * blockSize;
		const data = readAt(start, Math.min(blockSize, size - start));
		cache.set(index, data);
		if (cache.size > maxBlocks) cache.delete(cache.keys().next().value as number);
		return data;
	};

	return {
		fileSize: () => size,
		read(memory, offset, length, position) {
			if (position >= size || length <= 0) return 0;
			const end = Math.min(size, position + length);
			let pos = position;
			let out = offset;
			while (pos < end) {
				const index = Math.floor(pos / blockSize);
				const data = block(index);
				const within = pos - index * blockSize;
				const n = Math.min(data.length - within, end - pos);
				if (n <= 0) break;
				memory.set(data.subarray(within, within + n), out);
				pos += n;
				out += n;
			}
			return pos - position;
		},
		close() {
			cache.clear();
			onClose();
		},
	};
}
