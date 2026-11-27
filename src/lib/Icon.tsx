// Tiny inline icon set (24px grid, stroke-based). Add paths here as tools need them.
const PATHS = {
	arrow: "M5 12h14M13 6l6 6-6 6",
	back: "M19 12H5M11 18l-6-6 6-6",
	upload: "M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
	swap: "M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7",
	book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Zm0 14a2 2 0 0 1 2-2h13",
	info: "M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
	alert: "M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
	check: "M20 6 9 17l-5-5",
	x: "M18 6 6 18M6 6l12 12",
	code: "m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14",
	lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z",
	menu: "M4 6h16M4 12h16M4 18h10",
	text: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6M8 13h8M8 17h5",
	download: "M12 4v12M7 11l5 5 5-5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
	archive: "M4 3h16v5H4zM5 8v13h14V8M10 12h4",
	folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
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
