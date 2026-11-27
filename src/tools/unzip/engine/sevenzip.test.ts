import { gzipSync, zstdCompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
	archiveOfNames,
	compileSevenZip,
	compressArchive,
	makeArchive,
	memoryArchive,
	nestedNote,
	note,
	password,
} from "../../../../e2e/archives.ts";
import type { Archive } from "./listing.ts";
import { type ArchiveSource, archiveEngine } from "./sevenzip.ts";

describe("7-Zip archive engine", () => {
	let compiled: WebAssembly.Module;
	let engine: ReturnType<typeof archiveEngine>;
	beforeAll(async () => {
		compiled = await compileSevenZip();
		engine = archiveEngine(compiled);
	});

	async function contents(source: ArchiveSource, archive: Archive, secret: string, names: string[]) {
		const result: Record<string, string> = {};
		const selected = new Set(archive.entries.flatMap((entry, index) => (names.includes(entry.path) ? [index] : [])));
		let path = "";
		await engine.extract(source, archive, secret, selected, {
			start(index) {
				path = archive.entries[index].path;
				result[path] = "";
			},
			write(chunk) {
				result[path] += Buffer.from(chunk).toString();
			},
			end() {},
		});
		return result;
	}

	it.each(["zip", "7z", "tar"])("lists and streams a subset from %s", async (format) => {
		const name = `sample.${format}`;
		const source = memoryArchive(name, await makeArchive(compiled, name));
		const archive = await engine.list(source, name, "");
		expect(archive.format).toBe(format);
		expect(archive.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "empty-dir", folder: true })]),
		);
		expect(await contents(source, archive, "", ["zero.txt", "nested/cabin.txt", "notice.txt"])).toEqual({
			"notice.txt": note,
			"nested/cabin.txt": nestedNote,
			"zero.txt": "",
		});
	});

	it.each([
		["gz", "gzip"],
		["bz2", "bzip2"],
		["xz", "xz"],
		["zst", "zstd"],
	])("opens a tar.%s by its streamed contents", async (suffix, format) => {
		const tar = await makeArchive(compiled, "sample.tar");
		const name = `sample.tar.${suffix}`;
		const bytes =
			format === "zstd" ? zstdCompressSync(tar) : await compressArchive(compiled, "sample.tar", tar, name, format);
		const source = memoryArchive(name, bytes);
		const archive = await engine.list(source, name, "");
		expect(archive.compressedTar).toBe(true);
		expect(archive.format).toBe(`tar.${suffix}`);
		expect(await contents(source, archive, "", ["nested/cabin.txt"])).toEqual({ "nested/cabin.txt": nestedNote });
	});

	it("uses the uncompressed size and filename for a standalone gzip stream", async () => {
		const source = memoryArchive("archive.gz", gzipSync(note));
		const archive = await engine.list(source, "notice.txt.gz", "");
		expect(archive).toMatchObject({ format: "gzip", total: note.length, compressedTar: false });
		expect(await contents(source, archive, "", ["notice.txt"])).toEqual({ "notice.txt": note });
	});

	it("distinguishes missing and wrong passwords for AES ZIP entries", async () => {
		const name = "secret.zip";
		const source = memoryArchive(name, await makeArchive(compiled, name, [`-p${password}`, "-mem=AES256"]));
		const archive = await engine.list(source, name, "");
		expect(archive.entries.filter((entry) => entry.encrypted)).toHaveLength(4);
		await expect(contents(source, archive, "", ["notice.txt"])).rejects.toThrow("NEEDS_PASSWORD");
		await expect(contents(source, archive, "wrong", ["notice.txt"])).rejects.toThrow("WRONG_PASSWORD");
		expect(await contents(source, archive, password, ["notice.txt"])).toEqual({ "notice.txt": note });
	});

	it("opens an encrypted-header 7z only with the right password", async () => {
		const name = "secret.7z";
		const source = memoryArchive(name, await makeArchive(compiled, name, [`-p${password}`, "-mhe=on"]));
		await expect(engine.list(source, name, "")).rejects.toThrow("NEEDS_PASSWORD");
		await expect(engine.list(source, name, "wrong")).rejects.toThrow("WRONG_PASSWORD");
		const archive = await engine.list(source, name, password);
		expect(await contents(source, archive, password, ["notice.txt"])).toEqual({ "notice.txt": note });
	});

	it("extracts an entry whose listed path had a newline replaced by 7-Zip", async () => {
		const name = "oddities.zip";
		const source = memoryArchive(name, archiveOfNames(["other.txt", "new\nline.txt", "bracket[1].txt"]));
		const archive = await engine.list(source, name, "");
		expect(await contents(source, archive, "", ["new_line.txt"])).toEqual({ "new_line.txt": "Synthetic file 2\n" });
		expect(await contents(source, archive, "", ["bracket[1].txt"])).toEqual({ "bracket[1].txt": "Synthetic file 3\n" });
	});

	it("keeps selected literal paths distinct", async () => {
		const name = "literals.zip";
		const paths = [
			"../outside.txt",
			"/absolute.txt",
			"C:/drive.txt",
			"@mail.txt",
			"-flag.txt",
			'"quoted"',
			"pattern?.txt",
			"pattern1.txt",
			"café.txt",
		];
		const source = memoryArchive(name, archiveOfNames(paths));
		const archive = await engine.list(source, name, "");
		for (const [index, path] of paths.entries()) {
			expect(await contents(source, archive, "", [path]), path).toEqual({ [path]: `Synthetic file ${index + 1}\n` });
		}
	});
});
