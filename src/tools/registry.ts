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
];
