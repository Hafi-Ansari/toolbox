// Recently opened books, kept on this device in the Origin Private File System
// (private to this site, never uploaded). Each book is a copy of the EPUB plus
// a small cover thumbnail; library.json holds metadata and reading positions.
import type { Book } from "./book.ts";
import type { Anchor } from "./paginate.ts";

export interface Position {
	spine: number;
	anchor: Anchor | null;
	/** 0–1 within the chapter. */
	fraction: number;
	/** 0–1 through the whole book. */
	percent: number;
}

export interface LibraryEntry {
	id: string;
	title: string;
	author: string;
	size: number;
	added: number;
	opened: number;
	hasCover: boolean;
	position?: Position;
}

const MAX_BOOKS = 20;
const INDEX = "library.json";

let dirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

function libraryDir(): Promise<FileSystemDirectoryHandle | null> {
	dirPromise ??= (async () => {
		try {
			if (!navigator.storage?.getDirectory) return null;
			if (!("createWritable" in FileSystemFileHandle.prototype)) return null;
			const root = await navigator.storage.getDirectory();
			return await root.getDirectoryHandle("reader-library", { create: true });
		} catch {
			return null;
		}
	})();
	return dirPromise;
}

export async function libraryAvailable(): Promise<boolean> {
	return (await libraryDir()) !== null;
}

// All index writes go through one queue so concurrent updates never interleave.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => {});
	return next;
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<LibraryEntry[]> {
	try {
		const file = await (await dir.getFileHandle(INDEX)).getFile();
		const data = JSON.parse(await file.text());
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

async function writeFile(
	dir: FileSystemDirectoryHandle,
	name: string,
	data: Blob | string | ReadableStream<Uint8Array>,
) {
	const handle = await dir.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	try {
		if (data instanceof ReadableStream) await data.pipeTo(writable);
		else {
			await writable.write(data);
			await writable.close();
		}
	} catch (e) {
		await writable.abort().catch(() => {});
		throw e;
	}
}

async function remove(dir: FileSystemDirectoryHandle, name: string) {
	await dir.removeEntry(name).catch(() => {});
}

export async function listBooks(): Promise<LibraryEntry[]> {
	const dir = await libraryDir();
	if (!dir) return [];
	return (await readIndex(dir)).sort((a, b) => b.opened - a.opened);
}

async function makeCover(book: Book): Promise<Blob | null> {
	if (!book.coverPath) return null;
	try {
		const type = book.manifest.get(book.coverPath)?.mediaType ?? "image/jpeg";
		if (type.includes("svg")) return null;
		const bitmap = await createImageBitmap(await book.zip.blobOf(book.coverPath, type), {
			resizeWidth: 240,
			resizeQuality: "medium",
		});
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
		bitmap.close();
		return await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
	} catch {
		return null;
	}
}

/**
 * Adds (or refreshes) a book. The file is streamed into storage, so even very
 * large books never sit in memory. Resolves to null if storage is unavailable.
 */
export async function addBook(file: File, book: Book): Promise<LibraryEntry | null> {
	const dir = await libraryDir();
	if (!dir) return null;
	void navigator.storage.persist?.().catch(() => {});

	const existing = (await readIndex(dir)).find((e) => e.id === book.id);
	if (!existing) {
		await writeFile(dir, `${book.id}.epub`, file.stream());
		const cover = await makeCover(book);
		if (cover) await writeFile(dir, `${book.id}.webp`, cover);
	}

	return serialized(async () => {
		const index = await readIndex(dir);
		const now = Date.now();
		let entry = index.find((e) => e.id === book.id);
		if (entry) entry.opened = now;
		else {
			entry = {
				id: book.id,
				title: book.title,
				author: book.author,
				size: file.size,
				added: now,
				opened: now,
				hasCover: (await dir.getFileHandle(`${book.id}.webp`).catch(() => null)) !== null,
			};
			index.push(entry);
		}
		index.sort((a, b) => b.opened - a.opened);
		for (const old of index.splice(MAX_BOOKS)) {
			await remove(dir, `${old.id}.epub`);
			await remove(dir, `${old.id}.webp`);
		}
		await writeFile(dir, INDEX, JSON.stringify(index));
		return entry;
	});
}

export async function getBookFile(id: string): Promise<File | null> {
	const dir = await libraryDir();
	if (!dir) return null;
	try {
		return await (await dir.getFileHandle(`${id}.epub`)).getFile();
	} catch {
		return null;
	}
}

export async function getEntry(id: string): Promise<LibraryEntry | null> {
	return (await listBooks()).find((e) => e.id === id) ?? null;
}

export async function coverUrl(id: string): Promise<string | null> {
	const dir = await libraryDir();
	if (!dir) return null;
	try {
		return URL.createObjectURL(await (await dir.getFileHandle(`${id}.webp`)).getFile());
	} catch {
		return null;
	}
}

export async function savePosition(id: string, position: Position): Promise<void> {
	const dir = await libraryDir();
	if (!dir) return;
	await serialized(async () => {
		const index = await readIndex(dir);
		const entry = index.find((e) => e.id === id);
		if (!entry) return;
		entry.position = position;
		entry.opened = Date.now();
		await writeFile(dir, INDEX, JSON.stringify(index));
	});
}

export async function removeBook(id: string): Promise<void> {
	const dir = await libraryDir();
	if (!dir) return;
	await serialized(async () => {
		const index = (await readIndex(dir)).filter((e) => e.id !== id);
		await remove(dir, `${id}.epub`);
		await remove(dir, `${id}.webp`);
		await writeFile(dir, INDEX, JSON.stringify(index));
	});
}

export async function clearLibrary(): Promise<void> {
	const dir = await libraryDir();
	if (!dir) return;
	await serialized(async () => {
		for (const e of await readIndex(dir)) {
			await remove(dir, `${e.id}.epub`);
			await remove(dir, `${e.id}.webp`);
		}
		await writeFile(dir, INDEX, "[]");
	});
}
