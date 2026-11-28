// Small browser hooks for the page: a ticking clock, throttled values, the screen wake lock and the tab title.
import { useEffect, useRef, useState } from "react";

/** `Date.now()`, refreshed every `ms`. */
export function useNow(ms: number): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

/**
 * `value`, but changing at most once every `ms`: the latest value shows when the interval is up. `immediate`
 * lets a change through at once (phase changes shouldn't wait).
 */
export function useThrottled<T>(value: T, ms: number, immediate?: (prev: T, next: T) => boolean): T {
	const [shown, setShown] = useState(value);
	const last = useRef(0);
	const latest = useRef(value);
	latest.current = value;
	const shownRef = useRef(shown);
	shownRef.current = shown;
	const check = useRef(immediate);
	check.current = immediate;
	useEffect(() => {
		if (Object.is(value, shownRef.current)) return;
		const wait = last.current + ms - Date.now();
		if (wait <= 0 || check.current?.(shownRef.current, value)) {
			last.current = Date.now();
			setShown(value);
			return;
		}
		const t = setTimeout(() => {
			last.current = Date.now();
			setShown(latest.current);
		}, wait);
		return () => clearTimeout(t);
	}, [value, ms]);
	return shown;
}

interface WakeLockLike {
	release(): Promise<void>;
	addEventListener(type: "release", l: () => void): void;
}

/** Keeps the screen on while `on` and the tab is visible; re-acquired when the tab comes back (§7.5). No prompt. */
export function useWakeLock(on: boolean) {
	useEffect(() => {
		const wl = (navigator as { wakeLock?: { request(type: "screen"): Promise<WakeLockLike> } }).wakeLock;
		if (!on || !wl) return;
		let lock: WakeLockLike | null = null;
		let stopped = false;
		const acquire = () => {
			if (stopped || document.hidden || lock) return;
			wl.request("screen").then(
				(l) => {
					if (stopped) void l.release().catch(() => {});
					else {
						lock = l;
						l.addEventListener("release", () => {
							if (lock === l) lock = null;
						});
					}
				},
				() => {},
			);
		};
		const onVisible = () => !document.hidden && acquire();
		document.addEventListener("visibilitychange", onVisible);
		acquire();
		return () => {
			stopped = true;
			document.removeEventListener("visibilitychange", onVisible);
			void lock?.release().catch(() => {});
		};
	}, [on]);
}

/** True while the tab is hidden. */
export function useHidden(): boolean {
	const [hidden, setHidden] = useState(() => document.hidden);
	useEffect(() => {
		const on = () => setHidden(document.hidden);
		document.addEventListener("visibilitychange", on);
		return () => document.removeEventListener("visibilitychange", on);
	}, []);
	return hidden;
}

/** Shows `title` in the tab while it's set (the badge in place of a Notification, §4.2); restores the old one after. */
export function useTabTitle(title: string | null) {
	useEffect(() => {
		if (!title) return;
		const before = document.title;
		document.title = title;
		return () => {
			document.title = before;
		};
	}, [title]);
}
