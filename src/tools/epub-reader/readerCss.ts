// The reader stylesheet, injected last into each chapter so it wins over the
// publisher's CSS. Regenerated (and swapped in place) when settings or the
// page geometry change, without re-rendering the chapter.
import { type ReaderSettings, THEMES } from "./settings.ts";

export interface Geometry {
	/** Iframe (page) width and height in px. */
	width: number;
	height: number;
	/** Horizontal and vertical padding inside the page. */
	padX: number;
	padY: number;
}

const SERIF = `"Iowan Old Style", "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif`;
const SANS = `"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

export function readerCss(s: ReaderSettings, g: Geometry, fixed: boolean): string {
	const t = THEMES[s.theme];
	if (fixed) {
		// Fixed-layout pages keep the publisher's design; only the surround is themed.
		return `html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
html { background: ${t.bg}; }
${s.dimImages ? "img, svg, video { filter: brightness(0.9); }" : ""}`;
	}

	const colW = g.width - 2 * g.padX;
	const pageH = g.height - 2 * g.padY;
	const font = s.font === "serif" ? SERIF : s.font === "sans" ? SANS : "";

	const layout =
		s.mode === "paged"
			? `html { height: 100% !important; overflow: hidden !important; }
body {
	box-sizing: border-box !important;
	height: ${g.height}px !important;
	padding: ${g.padY}px ${g.padX}px !important;
	column-width: ${colW}px !important;
	column-gap: ${2 * g.padX}px !important;
	column-fill: auto !important;
	overflow: visible !important;
}
img, svg, video, figure, table { break-inside: avoid; }`
			: `html { overflow-x: hidden !important; overflow-y: auto !important; scrollbar-width: thin; scrollbar-color: ${t.muted} transparent; }
body { padding: ${g.padY}px ${g.padX}px ${g.height * 0.4}px !important; }`;

	const colors =
		s.colors === "override"
			? `body * { color: inherit !important; background-color: transparent !important; border-color: ${t.muted}55 !important; }
a, a * { color: ${t.link} !important; }
::selection { background: ${t.link}55; }
${
	// Justified text in a narrow column leaves rivers of space; read ragged-right instead.
	colW < 520 ? "p, li, blockquote, div { text-align: start !important; }" : ""
}`
			: "";

	return `:root { color-scheme: dark; }
html {
	background: ${t.bg} !important;
	color: ${t.text};
	font-size: ${s.size}px !important;
	-webkit-text-size-adjust: 100%;
	text-size-adjust: 100%;
}
body {
	margin: 0 !important;
	max-width: none !important;
	width: auto !important;
	min-height: 0 !important;
	color: ${t.text};
	font-size: 1rem !important;
	line-height: ${s.lineHeight} !important;
	overflow-wrap: break-word;
	hyphens: auto;
	-webkit-hyphens: auto;
	text-rendering: optimizeLegibility;
}
${font ? `body, body *:not(code):not(pre):not(kbd):not(samp):not(tt) { font-family: ${font} !important; }` : ""}
p, li, blockquote, dd { line-height: inherit !important; }
a { text-decoration-thickness: 1px; text-underline-offset: 2px; }
img, svg, video {
	max-width: 100% !important;
	/* Leave room for figure margins and a caption line: an image capped at the
	   full page height plus its margins doesn't fit any page, which leaves a
	   blank page before it. */
	max-height: calc(${pageH}px - 4em) !important;
	height: auto;
	object-fit: contain;
	${s.dimImages ? "filter: brightness(0.9);" : ""}
}
pre { white-space: pre-wrap !important; max-width: 100%; }
table { max-width: 100%; }
${colors}
${layout}`;
}
