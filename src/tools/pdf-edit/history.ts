import type { Item } from "./items.ts";

interface History {
	past: Item[][];
	items: Item[];
	future: Item[][];
}

export type HistoryAction = { type: "change"; update: (items: Item[]) => Item[] } | { type: "undo" | "redo" };

export const EMPTY_HISTORY: History = { past: [], items: [], future: [] };

export function editHistory(state: History, action: HistoryAction): History {
	const { past, items, future } = state;
	switch (action.type) {
		case "change": {
			const next = action.update(items);
			return next === items ? state : { past: [...past.slice(-99), items], items: next, future: [] };
		}
		case "undo": {
			const previous = past.at(-1);
			return previous ? { past: past.slice(0, -1), items: previous, future: [items, ...future] } : state;
		}
		case "redo": {
			const next = future[0];
			return next ? { past: [...past, items], items: next, future: future.slice(1) } : state;
		}
	}
}
