import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ZipWriter } from "../src/lib/zipWriter.ts";
import { type ArchiveSource, newSevenZip } from "../src/tools/unzip/engine/sevenzip.ts";

const require = createRequire(import.meta.url);
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
	"base64",
);
export const note = "A receipt from a shop on Mars.\n";
export const nestedNote = "Cabin three has a green door.\n";
export const sampleTotal = note.length + nestedNote.length + PNG.length;
export const password = "open-sesame";

export function compileSevenZip(): Promise<WebAssembly.Module> {
	return WebAssembly.compile(new Uint8Array(readFileSync(require.resolve("7z-wasm/7zz.wasm"))));
}

export function memoryArchive(path: string, data: Uint8Array): ArchiveSource {
	return { path, mount: ({ FS }) => FS.writeFile(path, data) };
}

export async function makeArchive(compiled: WebAssembly.Module, name: string, options: string[] = []) {
	const errors: string[] = [];
	const cli = await newSevenZip(
		compiled,
		() => {},
		(error) => errors.push(error),
	);
	cli.FS.mkdir("nested");
	cli.FS.mkdir("empty-dir");
	cli.FS.writeFile("notice.txt", note);
	cli.FS.writeFile("nested/cabin.txt", nestedNote);
	cli.FS.writeFile("nested/pixel.png", PNG);
	cli.FS.writeFile("zero.txt", "");
	const code = Number(
		cli.callMain(["a", "-bsp0", "-y", ...options, name, "empty-dir", "nested", "notice.txt", "zero.txt"]),
	);
	if (code !== 0) throw new Error(errors.join("\n"));
	return cli.FS.readFile(name);
}

export async function compressArchive(
	compiled: WebAssembly.Module,
	inputName: string,
	input: Uint8Array,
	outputName: string,
	format: string,
) {
	const errors: string[] = [];
	const cli = await newSevenZip(
		compiled,
		() => {},
		(error) => errors.push(error),
	);
	cli.FS.writeFile(inputName, input);
	const code = Number(cli.callMain(["a", "-bsp0", "-y", `-t${format}`, outputName, inputName]));
	if (code !== 0) throw new Error(errors.join("\n"));
	return cli.FS.readFile(outputName);
}

export function archiveOfNames(names: string[]) {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((part) => parts.push(part));
	for (const [i, name] of names.entries()) zip.add(name, new TextEncoder().encode(`Synthetic file ${i + 1}\n`), false);
	zip.finish();
	return Buffer.concat(parts);
}

export async function archiveFixtures() {
	mkdirSync("out/unzip", { recursive: true });
	const compiled = await compileSevenZip();
	const tar = await makeArchive(compiled, "sample.tar");
	for (const [name, bytes] of [
		["sample.zip", await makeArchive(compiled, "sample.zip")],
		["sample.7z", await makeArchive(compiled, "sample.7z")],
		["sample.tar.gz", await compressArchive(compiled, "sample.tar", tar, "sample.tar.gz", "gzip")],
		["secret.zip", await makeArchive(compiled, "secret.zip", [`-p${password}`, "-mem=AES256"])],
		["secret-names.7z", await makeArchive(compiled, "secret-names.7z", [`-p${password}`, "-mhe=on"])],
		[
			"unsafe-names.zip",
			archiveOfNames([
				"../escape.txt",
				"/abs.txt",
				"right\u202Eto-left.txt",
				"control\u0007.txt",
				"CON .txt",
				"nested/ok.txt",
				"../Nested/OK.TXT",
			]),
		],
	] as const)
		writeFileSync(`out/unzip/${name}`, bytes);
}
