// Manual overrides in the UI: kept per file in localStorage, listed with a way
// to show and undo each. The engine applies them (engine/overrides.ts).
import { Icon } from "../../lib/Icon.tsx";
import {
	type Box,
	lineIn,
	type Mode,
	type OutLine,
	type Override,
	PASSAGE_KIND,
	type SourceSpan,
} from "./engine/index.ts";
import s from "./PdfTxt.module.css";

const storageKey = (f: File) => `toolbox.pdf-txt.overrides:${f.name}:${f.size}:${f.lastModified}`;

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const pos = (p: unknown) => !!p && num((p as { page: unknown }).page) && num((p as { y: unknown }).y);
const valid = (o: unknown): o is Override => {
	if (!o || typeof o !== "object") return false;
	const v = o as { kind?: unknown; span?: SourceSpan; at?: unknown };
	if (v.kind === "join") return pos(v.at);
	return (v.kind === "lines" || v.kind === "reflow") && !!v.span && pos(v.span.from) && pos(v.span.to);
};

/** The overrides saved for this file (same name, size and date), or none. */
export function loadOverrides(file: File): Override[] {
	try {
		const list: unknown = JSON.parse(localStorage.getItem(storageKey(file)) ?? "[]");
		return Array.isArray(list) ? list.filter(valid) : [];
	} catch {
		return [];
	}
}

export function saveOverrides(file: File, overrides: Override[]) {
	try {
		if (overrides.length) localStorage.setItem(storageKey(file), JSON.stringify(overrides));
		else localStorage.removeItem(storageKey(file));
	} catch {
		// Storage can be unavailable (private mode); overrides just won't survive a reload.
	}
}

const LABELS: Record<Override["kind"], string> = {
	lines: "Printed lines kept",
	reflow: "Reflowed as prose",
	join: "Lines joined",
};

/** Where an override sits in the current text: the TXT lines it covers, and a box around it on its first page. */
export function findOverride(lines: OutLine[], o: Override): { first: number; last: number; page: number; box?: Box } {
	const hit = (l: OutLine) =>
		o.kind === "join"
			? !!l.span &&
				(l.span.from.page < o.at.page || (l.span.from.page === o.at.page && l.span.from.y <= o.at.y)) &&
				(l.span.to.page > o.at.page || (l.span.to.page === o.at.page && l.span.to.y >= o.at.y))
			: lineIn(o.span, l);
	const first = lines.findIndex(hit);
	let last = first;
	for (let i = first + 1; i < lines.length && first >= 0; i++) if (hit(lines[i])) last = i;
	const page = o.kind === "join" ? o.at.page : o.span.from.page;
	let box: Box | undefined;
	for (let i = Math.max(0, first); i <= last && first >= 0; i++) {
		const b = lines[i].box;
		if (!b || lines[i].span?.from.page !== page) continue;
		box = box
			? {
					x0: Math.min(box.x0, b.x0),
					y0: Math.min(box.y0, b.y0),
					x1: Math.max(box.x1, b.x1),
					y1: Math.max(box.y1, b.y1),
				}
			: b;
	}
	return { first, last, page, box };
}

const pages = (o: Override) => {
	if (o.kind === "join") return `p. ${o.at.page + 1}`;
	const a = o.span.from.page + 1;
	const b = o.span.to.page + 1;
	return a === b ? `p. ${a}` : `pp. ${a}–${b}`;
};

/** The list of active overrides, shown above the review flags. */
export function OverrideList({
	overrides,
	mode,
	onShow,
	onUndo,
}: {
	overrides: Override[];
	mode: Mode;
	onShow: (o: Override) => void;
	onUndo: (o: Override) => void;
}) {
	if (!overrides.length) return null;
	const idle = (o: Override) => o.kind !== "join" && o.kind !== PASSAGE_KIND[mode];
	return (
		<details className={s.flags} open>
			<summary>
				Your changes <span className={s.paneMeta}>· {overrides.length} · kept for this file on this device</span>
			</summary>
			<ul>
				{overrides.map((o, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: overrides have no id; the list is short and rebuilt on change
					<li key={`${o.kind}:${i}`} className={s.override}>
						<button type="button" onClick={() => onShow(o)} className={s.flag}>
							<span className={idle(o) ? s.flagNote : s.overrideKind}>{LABELS[o.kind]}</span>
							<span className={s.flagPage}>{pages(o)}</span>
							<span className={s.flagReason}>
								{o.text ? `“${o.text}”` : ""}
								{idle(o) && ` · applies in ${o.kind === "lines" ? "prose" : "poetry"} mode`}
							</span>
						</button>
						<button
							type="button"
							className={s.barButton}
							onClick={() => onUndo(o)}
							aria-label={`Undo: ${LABELS[o.kind]}, ${pages(o)}`}
						>
							<Icon name="x" size={14} />
							Undo
						</button>
					</li>
				))}
			</ul>
		</details>
	);
}
