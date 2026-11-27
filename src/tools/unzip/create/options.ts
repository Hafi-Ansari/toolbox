// Archive options and how they map to 7-Zip's command line.

export type Format = "zip" | "7z" | "tar.gz";
export type Level = "store" | "fast" | "normal" | "max";

export interface CreateOptions {
	format: Format;
	level: Level;
	/** Empty for no password. Ignored for tar.gz, which has no encryption. */
	password: string;
}

export const LEVELS: Record<Level, number> = { store: 0, fast: 1, normal: 5, max: 9 };
/** fflate's gzip levels for the same choices. */
export const GZIP_LEVELS: Record<Level, 0 | 1 | 6 | 9> = { store: 0, fast: 1, normal: 6, max: 9 };

export const extension = (format: Format) => `.${format}`;

export const mimeType = (format: Format) =>
	format === "zip" ? "application/zip" : format === "7z" ? "application/x-7z-compressed" : "application/gzip";

export const supportsPassword = (format: Format) => format !== "tar.gz";

/**
 * Switches for `7zz a`. The caller appends the output path and the inputs.
 * tar.gz runs 7-Zip as a tar writer to stdout and gzips the stream in JavaScript.
 */
export function sevenZipSwitches({ format, level, password }: CreateOptions): string[] {
	const common = ["-bsp0", "-bso0", "-sccUTF-8", "-y"];
	if (format === "tar.gz") return ["-ttar", "-so", ...common];
	const switches = [`-t${format}`, `-mx${LEVELS[level]}`, ...common];
	// Always mark UTF-8 names in ZIP, so non-ASCII names survive every unzipper.
	if (format === "zip") switches.push("-mcu=on");
	if (password) {
		switches.push(`-p${password}`);
		switches.push(format === "zip" ? "-mem=AES256" : "-mhe=on");
	}
	return switches;
}
