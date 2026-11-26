export type Theme = "night" | "black" | "dusk" | "sepia" | "paper";
export type FontChoice = "original" | "serif" | "classic" | "sans" | "rounded" | "mono";
export type Width = "narrow" | "medium" | "wide";
export type Mode = "paged" | "scroll";
export type Align = "original" | "left" | "justify";

export interface ReaderSettings {
	theme: Theme;
	/** "override" forces the theme's (or the chosen) text color; "original" keeps the publisher's. */
	colors: "override" | "original";
	/** A custom text color (#rrggbb), or null for the theme's own. Only applies with colors: "override". */
	textColor: string | null;
	font: FontChoice;
	/** Base font size in px. */
	size: number;
	/** Extra stroke weight, 0 (the font's own) to WEIGHT_MAX. Works with any font, keeps bold/regular distinct. */
	weight: number;
	/** Line height multiplier. */
	lineHeight: number;
	/** Space between paragraphs in em, or null to keep the book's. */
	paragraph: number | null;
	align: Align;
	width: Width;
	mode: Mode;
	dimImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	theme: "night",
	colors: "override",
	textColor: null,
	font: "serif",
	size: 19,
	weight: 0,
	lineHeight: 1.6,
	paragraph: null,
	align: "original",
	width: "medium",
	mode: "paged",
	dimImages: true,
};

export const SIZE_MIN = 14;
export const SIZE_MAX = 32;
export const WEIGHT_MAX = 3;
export const LINE_MIN = 1.2;
export const LINE_MAX = 2.2;

const KEY = "toolbox.reader.settings";

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(v as T) ? (v as T) : fallback;
const num = (v: unknown, min: number, max: number, fallback: number) => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Validates stored settings (older versions used other names and string values). */
export function normalizeSettings(raw: Record<string, unknown>): ReaderSettings {
	const d = DEFAULT_SETTINGS;
	const theme = raw.theme === "dark" ? "night" : raw.theme;
	return {
		theme: pick(theme, ["night", "black", "dusk", "sepia", "paper"], d.theme),
		colors: pick(raw.colors, ["override", "original"], d.colors),
		textColor: typeof raw.textColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.textColor) ? raw.textColor : null,
		font: pick(raw.font, ["original", "serif", "classic", "sans", "rounded", "mono"], d.font),
		size: Math.round(num(raw.size, SIZE_MIN, SIZE_MAX, d.size)),
		weight: Math.round(num(raw.weight, 0, WEIGHT_MAX, d.weight)),
		lineHeight: Math.round(num(raw.lineHeight, LINE_MIN, LINE_MAX, d.lineHeight) * 10) / 10,
		paragraph: raw.paragraph == null ? null : num(raw.paragraph, 0, 2, 0),
		align: pick(raw.align, ["original", "left", "justify"], d.align),
		width: pick(raw.width, ["narrow", "medium", "wide"], d.width),
		mode: pick(raw.mode, ["paged", "scroll"], d.mode),
		dimImages: typeof raw.dimImages === "boolean" ? raw.dimImages : d.dimImages,
	};
}

export function loadSettings(): ReaderSettings {
	try {
		return normalizeSettings(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(s: ReaderSettings) {
	try {
		localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		// unavailable storage: settings just don't persist
	}
}

/** Line length in em for each width setting (~60 / 70 / 80 characters). */
export const MEASURE_EM: Record<Width, number> = { narrow: 30, medium: 35, wide: 40 };

export interface ThemeColors {
	label: string;
	dark: boolean;
	/** Page background, body text, secondary text, links. */
	bg: string;
	text: string;
	muted: string;
	link: string;
	/** Reader chrome: panels, hairlines, the accent for selected controls. */
	surface: string;
	border: string;
	accent: string;
	/** Text on top of the accent color. */
	onAccent: string;
}

export const THEMES: Record<Theme, ThemeColors> = {
	night: {
		label: "Night",
		dark: true,
		bg: "#001e2b",
		text: "#e8edeb",
		muted: "#889397",
		link: "#71f6ba",
		surface: "#0a2a38",
		border: "#1f3a47",
		accent: "#00ed64",
		onAccent: "#012a1d",
	},
	black: {
		label: "Black",
		dark: true,
		bg: "#000000",
		text: "#dfe3e1",
		muted: "#7d8588",
		link: "#71f6ba",
		surface: "#121414",
		border: "#262a2a",
		accent: "#00ed64",
		onAccent: "#012a1d",
	},
	dusk: {
		label: "Dusk",
		dark: true,
		bg: "#22201d",
		text: "#e6ddd0",
		muted: "#9a9083",
		link: "#f0b36b",
		surface: "#2e2b27",
		border: "#433e37",
		accent: "#f0b36b",
		onAccent: "#2a1a05",
	},
	sepia: {
		label: "Sepia",
		dark: false,
		bg: "#f4ecd8",
		text: "#3b2f22",
		muted: "#857560",
		link: "#8a4b14",
		surface: "#fbf5e6",
		border: "#ddcfae",
		accent: "#8a4b14",
		onAccent: "#fff8ea",
	},
	paper: {
		label: "Paper",
		dark: false,
		bg: "#fbfbf8",
		text: "#1d2125",
		muted: "#6b7278",
		link: "#00684a",
		surface: "#ffffff",
		border: "#e2e4e2",
		accent: "#00684a",
		onAccent: "#ffffff",
	},
};

/** Quick text-color choices. Any color works through the picker too. */
export const TEXT_COLORS: { value: string; label: string }[] = [
	{ value: "#ffffff", label: "White" },
	{ value: "#c7ccd1", label: "Soft gray" },
	{ value: "#f3e6c8", label: "Cream" },
	{ value: "#ffcf87", label: "Amber" },
	{ value: "#b9f0d4", label: "Mint" },
	{ value: "#000000", label: "Black" },
	{ value: "#4a3a2a", label: "Brown" },
];

export const FONTS: Record<FontChoice, { label: string; stack: string }> = {
	original: { label: "Book", stack: "" },
	serif: {
		label: "Serif",
		stack: `"Iowan Old Style", "Charter", "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif`,
	},
	classic: {
		label: "Classic",
		stack: `"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", "Hoefler Text", Baskerville, Georgia, serif`,
	},
	sans: {
		label: "Sans",
		stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
	},
	rounded: {
		label: "Clear",
		stack: `Verdana, "Atkinson Hyperlegible", "Trebuchet MS", "DejaVu Sans", Tahoma, sans-serif`,
	},
	mono: {
		label: "Mono",
		stack: `ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`,
	},
};

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const [r, g, bl] = [1, 3, 5].map((i) => {
			const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
	return (x + 0.05) / (y + 0.05);
}
