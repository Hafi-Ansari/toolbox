// The reader stylesheet, injected into each chapter. It lives in the "reader" cascade
// layer, which comes before the "publisher" layer that holds the book's CSS (see
// render.ts). So the book's normal rules still shape the page, while the reader's
// !important rules (colors, fonts, size, spacing) win over the book's even when the book
// uses !important itself. Regenerated (and swapped in place) when settings or the page
// geometry change, without re-rendering the chapter.
import { FONTS, type ReaderSettings, THEMES } from "./settings.ts";

export interface Geometry {
	/** Iframe (page) width and height in px. */
	width: number;
	height: number;
	/** Horizontal and vertical padding inside the page. */
	padX: number;
	padY: number;
}

/** Attribute set on text blocks to record the book's own alignment (see markAlignment). */
export const ALIGN_ATTR = "data-ra";

/**
 * Records which text blocks the book justifies ("j") or sets ragged ("s"), measured with
 * the reader's own styles switched off. Centered and right-aligned blocks (titles, scene
 * breaks, epigraphs) stay unmarked, so the alignment setting never flattens them.
 */
export function markAlignment(doc: Document) {
	const own = doc.getElementById("reader-style") as HTMLStyleElement | null;
	const sheet = own?.sheet;
	if (sheet) sheet.disabled = true;
	const view = doc.defaultView;
	if (view) {
		for (const el of Array.from(doc.body?.querySelectorAll("p, div, li, blockquote, dd, dt, td, section") ?? [])) {
			const a = view.getComputedStyle(el).textAlign;
			const mark = a === "justify" ? "j" : a === "start" || a === "left" || a === "-webkit-auto" ? "s" : null;
			if (mark) el.setAttribute(ALIGN_ATTR, mark);
		}
	}
	if (sheet) sheet.disabled = false;
}

/** The text color the reader forces, or null when the book keeps its own colors. */
export function forcedTextColor(s: ReaderSettings): string | null {
	return s.colors === "override" ? (s.textColor ?? THEMES[s.theme].text) : null;
}

/**
 * Touch on the page: the reader handles taps and sideways swipes itself (gestures.ts), so the
 * browser only pans vertically and pinch-zooms. That also drops the double-tap-zoom wait and
 * keeps a sideways swipe from turning into the browser's "go back" gesture. No gray tap flash.
 */
const TOUCH = "touch-action: pan-y pinch-zoom !important; -webkit-tap-highlight-color: transparent;";

export function readerCss(s: ReaderSettings, g: Geometry, fixed: boolean): string {
	return `@layer reader {\n${rules(s, g, fixed)}\n}`;
}

function rules(s: ReaderSettings, g: Geometry, fixed: boolean): string {
	const t = THEMES[s.theme];
	const dim = s.dimImages && t.dark ? "filter: brightness(0.88);" : "";
	if (fixed) {
		// Fixed-layout pages keep the publisher's design; only the surround is themed.
		return `html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
html { ${TOUCH} }
html { background: ${t.bg} !important; }
${dim ? `img, svg, video { ${dim} }` : ""}`;
	}

	const colW = g.width - 2 * g.padX;
	const pageH = g.height - 2 * g.padY;
	const font = FONTS[s.font].stack;
	const text = forcedTextColor(s);

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
body { padding: ${g.padY}px ${g.padX}px ${Math.round(g.height * 0.4)}px !important; }`;

	const colors = text
		? `body { color: ${text} !important; background: transparent !important; }
body * {
	color: inherit !important;
	-webkit-text-fill-color: currentColor !important;
	background-color: transparent !important;
	border-color: color-mix(in srgb, ${text} 30%, transparent) !important;
	text-shadow: none !important;
}
a, a * { color: ${t.link} !important; }
svg text, svg tspan { fill: currentColor !important; }
hr { background-color: color-mix(in srgb, ${text} 30%, transparent) !important; }`
		: "";

	const weight =
		s.weight > 0
			? // A hairline stroke thickens every glyph of any font by the same amount, so bold
				// stays bolder than regular (unlike forcing font-weight, which flattens both).
				`body { -webkit-text-stroke: ${(s.weight * 0.017).toFixed(3)}em currentColor !important; paint-order: stroke fill; }`
			: "";

	// Auto keeps the book's alignment, except that justified text in a narrow column
	// (phones) leaves rivers of space, so it reads ragged-right there.
	const align =
		s.align === "left" || (s.align === "original" && colW < 520)
			? `[${ALIGN_ATTR}="j"] { text-align: start !important; }`
			: s.align === "justify"
				? `[${ALIGN_ATTR}] { text-align: justify !important; hyphens: auto !important; -webkit-hyphens: auto !important; }`
				: "";

	const paragraph =
		s.paragraph != null ? `p { margin-top: 0 !important; margin-bottom: ${s.paragraph}em !important; }` : "";

	return `:root { color-scheme: ${t.dark ? "dark" : "light"}; }
html {
	background: ${t.bg} !important;
	color: ${t.text};
	font-size: ${s.size}px !important;
	-webkit-text-size-adjust: 100%;
	text-size-adjust: 100%;
	${TOUCH}
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
body *:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6) { line-height: inherit !important; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25 !important; }
a { text-decoration-thickness: 1px; text-underline-offset: 2px; }
::selection { background: color-mix(in srgb, ${t.link} 35%, transparent); }
img, svg, video {
	max-width: 100% !important;
	/* Leave room for figure margins and a caption line: an image capped at the
	   full page height plus its margins doesn't fit any page, which leaves a
	   blank page before it. */
	max-height: calc(${pageH}px - 4em) !important;
	height: auto;
	object-fit: contain;
	${dim}
}
pre { white-space: pre-wrap !important; max-width: 100%; }
table { max-width: 100%; }
${colors}
${weight}
${align}
${paragraph}
${layout}`;
}
