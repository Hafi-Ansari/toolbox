import type { Snapshot } from "./pages.ts";

export interface History {
	past: Snapshot[];
	present: Snapshot;
	future: Snapshot[];
}

export type HistoryAction =
	| { type: "change"; update: (state: Snapshot) => Snapshot }
	| { type: "undo" | "redo" }
	| { type: "reset"; state: Snapshot };

export function startHistory(state: Snapshot): History {
	return { past: [], present: state, future: [] };
}

export function editHistory(state: History, action: HistoryAction): History {
	const { past, present, future } = state;
	switch (action.type) {
		case "change": {
			const next = action.update(present);
			return next === present ? state : { past: [...past.slice(-99), present], present: next, future: [] };
		}
		case "undo": {
			const previous = past.at(-1);
			return previous ? { past: past.slice(0, -1), present: previous, future: [present, ...future] } : state;
		}
		case "redo": {
			const next = future[0];
			return next ? { past: [...past, present], present: next, future: future.slice(1) } : state;
		}
		case "reset":
			return startHistory(action.state);
	}
}
