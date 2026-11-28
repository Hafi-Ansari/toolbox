// The tool registry. Adding a tool = a new folder under src/tools/ with a
// default-export component, plus one entry here. Each tool is lazy-loaded into
// its own chunk, so tools never slow down the home page or each other.
import type { ComponentType } from "react";
import type { IconName } from "../lib/Icon.tsx";

export interface ToolMeta {
	id: string;
	path: string;
	title: string;
	blurb: string;
	icon: IconName;
	tags: string[];
	/**
	 * Served cross-origin isolated (COOP/COEP headers on its path, in vercel.json and vite.config.ts),
	 * for multithreaded WASM. Isolation is set per document, so the app enters and leaves such a tool
	 * with a full page load instead of client-side navigation.
	 */
	isolated?: boolean;
	load: () => Promise<{ default: ComponentType }>;
}

export const tools: ToolMeta[] = [
	{
		id: "epub-pdf",
		path: "/epub-pdf",
		title: "EPUB ⇄ PDF",
		blurb: "Convert ebooks to PDF and PDFs to ebooks. Any size, never uploaded.",
		icon: "swap",
		tags: ["EPUB", "PDF"],
		load: () => import("./epub-pdf/index.tsx"),
	},
	{
		id: "epub-reader",
		path: "/read",
		title: "EPUB Reader",
		blurb: "Read ebooks in a calm dark theme. Opens instantly, remembers your place.",
		icon: "book",
		tags: ["EPUB", "Reader"],
		load: () => import("./epub-reader/index.tsx"),
	},
	{
		id: "pdf-txt",
		path: "/pdf-txt",
		title: "PDF → TXT",
		blurb:
			"Turn a book of poems or prose into clean plain text, checked against the printed page. Scanned pages too, with OCR.",
		icon: "text",
		tags: ["PDF", "TXT", "Poetry"],
		load: () => import("./pdf-txt/index.tsx"),
	},
	{
		id: "unzip",
		path: "/unzip",
		title: "Zip / Unzip",
		blurb:
			"Open ZIP, 7z, RAR and other archives, or pack files and folders into a ZIP, 7z or TAR.GZ, with an optional password.",
		icon: "archive",
		tags: ["ZIP", "7z", "RAR"],
		load: () => import("./unzip/index.tsx"),
	},
	{
		id: "pdf-edit",
		path: "/pdf-edit",
		title: "PDF Editor",
		blurb:
			"Sign, fill in forms, and add text, drawings and images. Merge, split, reorder, rotate or delete pages. Never uploaded.",
		icon: "pen",
		tags: ["PDF", "Sign", "Merge", "Split"],
		load: () => import("./pdf-edit/index.tsx"),
	},
	{
		id: "room",
		path: "/room",
		title: "Shared room",
		blurb:
			"A text box and files every device can see. Make a room, open this page on your other device, tap the room, and paste or add files.",
		icon: "chat",
		tags: ["Text", "Files", "Sync"],
		load: () => import("./room/index.tsx"),
	},
	{
		id: "file-transfer",
		path: "/file-transfer",
		title: "Blazing Fast File Transfer",
		blurb:
			"Send photos, videos or whole folders straight to another device, as fast as your networks allow. Nothing is uploaded.",
		icon: "arrow",
		tags: ["Files", "P2P"],
		load: () => import("./file-transfer/index.tsx"),
	},
	{
		id: "photo",
		path: "/photo",
		title: "Photo Converter",
		blurb:
			"Convert iPhone HEIC photos to JPEG or PNG, and JPEG ⇄ PNG. Colors, orientation and details kept. Never uploaded.",
		icon: "image",
		tags: ["HEIC", "JPEG", "PNG"],
		load: () => import("./photo/index.tsx"),
	},
	{
		id: "transcribe",
		path: "/transcribe",
		title: "Video → Transcript",
		blurb:
			"Turn a video or audio file into a timestamped text transcript with Whisper, running on your own device. Never uploaded.",
		icon: "mic",
		tags: ["Video", "Audio", "TXT"],
		isolated: true,
		load: () => import("./transcribe/index.tsx"),
	},
];
