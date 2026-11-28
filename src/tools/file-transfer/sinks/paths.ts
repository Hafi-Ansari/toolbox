// Receiver-side path safety (SPEC §8.1), used by every sink. Whatever the sender claims, a path that
// comes out of here is relative, "/"-separated, free of traversal, control and bidi characters and
// Windows-reserved names, and within the length limits. Duplicates within a batch are renamed.
import { PATH_MAX, PATH_SEGMENT_MAX } from "../tuning.ts";

// Control characters, and the bidi marks and overrides that can make "exe.txt" read as "txt.exe"
// (as `cleanFileName` in api/rooms.ts).
const UNSAFE = /[\p{Cc}؜‎‏‪-‮⁦-⁩﻿]/gu;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

const chars = (s: string) => Array.from(s);

/** Splits a name into base and extension; the extension keeps its dot. Dotfiles have no extension. */
export function splitExt(name: string): [string, string] {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || name.length - dot > 21) return [name, ""];
	return [name.slice(0, dot), name.slice(dot)];
}

/** Cuts a segment to `max` characters, keeping the extension when there is room for it. */
function clip(segment: string, max: number): string {
	const all = chars(segment);
	if (all.length <= max) return segment;
	const [base, ext] = splitExt(segment);
	const extChars = chars(ext);
	if (extChars.length >= max / 2) return trimEnd(all.slice(0, max).join(""));
	return (
		trimEnd(
			chars(base)
				.slice(0, max - extChars.length)
				.join(""),
		) + ext
	);
}

const trimEnd = (s: string) => s.replace(/[. ]+$/, "");

/** One path segment, or "" when nothing usable is left (empty, ".", ".."). */
export function sanitizeSegment(raw: string): string {
	let s = raw
		.normalize("NFC")
		.replace(UNSAFE, "")
		.replace(/[<>:"|?*/]/g, "_");
	s = trimEnd(s.trim());
	if (!s) return "";
	s = clip(s, PATH_SEGMENT_MAX);
	if (RESERVED.test(s)) s = clip(`_${s}`, PATH_SEGMENT_MAX);
	return s;
}

/** A whole relative path; "file" when nothing usable is left. Not deduplicated (see `sanitizePaths`). */
export function sanitizePath(raw: string): string {
	const segments = raw
		.split(/[\\/]+/)
		.map(sanitizeSegment)
		.filter((s) => s !== "");
	if (!segments.length) return "file";
	return fitPath(segments);
}

/** Room left for a " (n)" suffix from `sanitizePaths`, so deduplicated paths stay within `PATH_MAX`. */
const DEDUP_ROOM = 10;

/** Keeps the file name and as many leading folders as fit within `PATH_MAX` (less room for a suffix). */
function fitPath(segments: string[]): string {
	const name = segments[segments.length - 1];
	let length = chars(name).length;
	const folders: string[] = [];
	for (const folder of segments.slice(0, -1)) {
		const add = chars(folder).length + 1;
		if (length + add > PATH_MAX - DEDUP_ROOM) break;
		folders.push(folder);
		length += add;
	}
	return [...folders, name].join("/");
}

/** "IMG.jpg" → "IMG (2).jpg", within the segment limit. */
export function numbered(name: string, n: number): string {
	const [base, ext] = splitExt(name);
	const suffix = ` (${n})${ext}`;
	return (
		trimEnd(
			chars(base)
				.slice(0, PATH_SEGMENT_MAX - chars(suffix).length)
				.join(""),
		) + suffix
	);
}

const key = (path: string) => path.toLowerCase();

/**
 * Sanitizes every path of a batch and makes them unique: a duplicate (compared case-insensitively, as
 * Windows and macOS do) gets " (2)", " (3)"… before its extension. A file whose path is also a folder of
 * another file is renamed the same way. Returns the paths in input order.
 */
export function sanitizePaths(raw: readonly string[]): string[] {
	const clean = raw.map(sanitizePath);
	const folders = new Set<string>();
	for (const path of clean) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) folders.add(key(parts.slice(0, i).join("/")));
	}
	const taken = new Set<string>();
	return clean.map((path) => {
		const slash = path.lastIndexOf("/");
		const dir = path.slice(0, slash + 1);
		const name = path.slice(slash + 1);
		let candidate = path;
		for (let n = 2; taken.has(key(candidate)) || folders.has(key(candidate)); n++) {
			candidate = dir + numbered(name, n);
		}
		taken.add(key(candidate));
		return candidate;
	});
}
