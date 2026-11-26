export type Theme = "dark" | "black";
export type FontChoice = "original" | "serif" | "sans";
export type Width = "narrow" | "medium" | "wide";
export type Mode = "paged" | "scroll";

export interface ReaderSettings {
	theme: Theme;
	/** "override" forces readable colors; "original" keeps the publisher's. */
	colors: "override" | "original";
	font: FontChoice;
	/** Base font size in px. */
	size: number;
	lineHeight: "1.4" | "1.6" | "1.8";
	width: Width;
	mode: Mode;
	dimImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	theme: "dark",
	colors: "override",
	font: "serif",
	size: 19,
	lineHeight: "1.6",
	width: "medium",
	mode: "paged",
	dimImages: true,
};

export const SIZE_MIN = 14;
export const SIZE_MAX = 28;

const KEY = "toolbox.reader.settings";

export function loadSettings(): ReaderSettings {
	try {
		return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
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

export const THEMES: Record<Theme, { bg: string; text: string; muted: string; link: string }> = {
	dark: { bg: "#001e2b", text: "#e8edeb", muted: "#889397", link: "#71f6ba" },
	black: { bg: "#000000", text: "#dfe3e1", muted: "#7d8588", link: "#71f6ba" },
};
