import type { Entry } from "./listing.ts";

const BLOCK = 512;
const decoder = new TextDecoder();
const string = (bytes: Uint8Array) => {
	const zero = bytes.indexOf(0);
	return decoder.decode(zero < 0 ? bytes : bytes.subarray(0, zero));
};

function number(bytes: Uint8Array): number {
	let n: number;
	if (bytes[0] & 0x80) {
		if (bytes[0] & 0x40) throw new Error("Negative TAR entry size.");
		n = bytes[0] & 0x7f;
		for (const byte of bytes.subarray(1)) n = n * 256 + byte;
	} else {
		const octal = string(bytes).trim();
		if (octal && !/^[0-7]+$/.test(octal)) throw new Error("Invalid TAR numeric field.");
		n = octal ? Number.parseInt(octal, 8) : 0;
	}
	if (!Number.isSafeInteger(n)) throw new Error("TAR entry is too large.");
	return n;
}

export function isTarHeader(header: Uint8Array): boolean {
	if (header.length !== BLOCK || header[0] === 0) return false;
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < BLOCK; i++) {
		const byte = i >= 148 && i < 156 ? 32 : header[i];
		unsigned += byte;
		signed += byte < 128 ? byte : byte - 256;
	}
	try {
		const checksum = number(header.subarray(148, 156));
		return checksum === unsigned || checksum === signed;
	} catch {
		return false;
	}
}

function pax(bytes: Uint8Array): Map<string, string> {
	const fields = new Map<string, string>();
	for (let at = 0; at < bytes.length; ) {
		const space = bytes.indexOf(32, at);
		const size = Number(string(bytes.subarray(at, space)));
		const end = at + size;
		if (space < 0 || !Number.isSafeInteger(size) || end <= space + 1 || end > bytes.length || bytes[end - 1] !== 10) {
			throw new Error("Invalid PAX record.");
		}
		const line = decoder.decode(bytes.subarray(space + 1, end - 1));
		const equals = line.indexOf("=");
		if (equals < 1) throw new Error("Invalid PAX field.");
		fields.set(line.slice(0, equals), line.slice(equals + 1));
		at = end;
	}
	return fields;
}

interface TarSink {
	start(entry: Entry): void;
	write(chunk: Uint8Array): void;
	end(): void;
}

/** Reads only one header and the current metadata record into memory. */
export function tarReader(sink: TarSink) {
	const global = new Map<string, string>();
	let local = new Map<string, string>();
	let longName: string | undefined;
	const block = new Uint8Array(BLOCK);
	let headerBytes = 0;
	let remaining = 0;
	let padding = 0;
	let ended = false;
	let notify = false;
	let metadata: Uint8Array | undefined;
	let type = "";

	function finishEntry() {
		if (metadata) {
			if (type === "L") longName = string(metadata);
			if (type === "x") for (const [key, value] of pax(metadata)) local.set(key, value);
			if (type === "g") {
				for (const [key, value] of pax(metadata)) {
					if (value) global.set(key, value);
					else global.delete(key);
				}
			}
			metadata = undefined;
		}
		if (notify) sink.end();
		notify = false;
	}

	function startEntry() {
		if (block.every((byte) => byte === 0)) {
			ended = true;
			return;
		}
		if (ended || !isTarHeader(block)) throw new Error("Invalid TAR header or checksum.");
		type = String.fromCharCode(block[156]);
		remaining = number(block.subarray(124, 136));
		if (type === "x" || type === "g" || type === "L" || type === "K") {
			if (remaining > 1 << 20) throw new Error("TAR metadata exceeds 1 MB.");
			metadata = new Uint8Array(remaining);
		} else {
			const get = (key: string) => local.get(key) ?? global.get(key);
			if (type === "S" || [...local.keys(), ...global.keys()].some((key) => key.startsWith("GNU.sparse"))) {
				throw new Error("Sparse TAR files are unsupported.");
			}
			const name = string(block.subarray(0, 100));
			const prefix = block[262] === 0 ? string(block.subarray(345, 500)) : "";
			const path = get("path") || longName || (prefix ? `${prefix}/${name}` : name);
			const size = get("size");
			if (size !== undefined && size !== "") {
				remaining = Number(size);
				if (!/^\d+$/.test(size) || !Number.isSafeInteger(remaining)) throw new Error("Invalid PAX size.");
			}
			const time = Number(get("mtime") ?? number(block.subarray(136, 148))) * 1000;
			const modified = Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
			local = new Map();
			longName = undefined;
			const folder = type === "5" || path.endsWith("/");
			if (folder || type === "0" || type === "\0" || type === "7") {
				sink.start({ path, size: folder ? 0 : remaining, modified, folder, encrypted: false });
				notify = true;
			}
		}
		padding = (BLOCK - (remaining % BLOCK)) % BLOCK;
		if (remaining === 0) finishEntry();
	}

	return {
		write(chunk: Uint8Array) {
			let at = 0;
			while (at < chunk.length) {
				if (remaining > 0) {
					const count = Math.min(remaining, chunk.length - at);
					const data = chunk.subarray(at, at + count);
					if (metadata) metadata.set(data, metadata.length - remaining);
					else if (notify) sink.write(data);
					remaining -= count;
					if (remaining === 0) finishEntry();
					at += count;
				} else if (padding > 0) {
					const count = Math.min(padding, chunk.length - at);
					padding -= count;
					at += count;
				} else {
					const count = Math.min(BLOCK - headerBytes, chunk.length - at);
					block.set(chunk.subarray(at, at + count), headerBytes);
					headerBytes += count;
					at += count;
					if (headerBytes === BLOCK) {
						headerBytes = 0;
						startEntry();
					}
				}
			}
		},
		finish() {
			if (remaining || padding || headerBytes || metadata || longName || local.size)
				throw new Error("Incomplete TAR archive.");
		},
	};
}
