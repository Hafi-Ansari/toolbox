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
		blurb: "Turn a book of poems or prose into clean plain text, checked against the printed page.",
		icon: "text",
		tags: ["PDF", "TXT", "Poetry"],
		load: () => import("./pdf-txt/index.tsx"),
	},
	{
		id: "pdf-edit",
		path: "/pdf-edit",
		title: "PDF Editor",
		blurb: "Add text, ink, marks, signatures and images to any page. Save an edited copy on your device.",
		icon: "pen",
		tags: ["PDF", "Sign", "Annotate"],
		load: () => import("./pdf-edit/index.tsx"),
	},
];
