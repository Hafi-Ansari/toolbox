// Text cleanup shared by every output format.

/** Strips control characters and lone surrogates: illegal in XML 1.0, junk in plain text. */
export function cleanText(s: string): string {
	return s.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"",
	);
}
