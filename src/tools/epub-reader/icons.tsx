// Icons used only by the reader (24px grid, stroke-based, like src/lib/Icon.tsx).
const PATHS = {
	back: "M15 6l-6 6 6 6",
	x: "M18 6 6 18M6 6l12 12",
	toc: "M4 6h16M4 12h16M4 18h10",
	book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Zm0 14a2 2 0 0 1 2-2h13",
	"chevron-left": "M15 5l-7 7 7 7",
	"chevron-right": "M9 5l7 7-7 7",
	"align-left": "M4 6h16M4 10h10M4 14h16M4 18h10",
	"align-justify": "M4 6h16M4 10h16M4 14h16M4 18h16",
	"lines-tight": "M5 8h14M5 11h14M5 14h14M5 17h14",
	"lines-loose": "M5 5h14M5 10h14M5 15h14M5 20h14",
	text: "M4 7V5h16v2M12 5v14M9 19h6",
	trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
	plus: "M12 5v14M5 12h14",
} as const;

export type ReaderIconName = keyof typeof PATHS;

export function RIcon({ name, size = 20, className }: { name: ReaderIconName; size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<path d={PATHS[name]} />
		</svg>
	);
}
