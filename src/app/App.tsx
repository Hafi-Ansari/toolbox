import { type ComponentType, lazy, type MouseEvent, Suspense, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Icon } from "../lib/Icon.tsx";
import { type ToolMeta, tools } from "../tools/registry.ts";
import s from "./App.module.css";
import { SOURCE_URL } from "./config.ts";

/*
 * Tool code loading. Each tool's code is fetched once (one shared promise), and once it has
 * arrived the component is kept here and rendered directly. React.lazy alone isn't enough: even
 * for code that's already loaded, its first render suspends on a fresh import() promise, React
 * commits the Suspense fallback, and React 19 then holds the fallback for ~300 ms before
 * revealing the tool. That was the blank flash on every tool's first open.
 */
const loading = new Map<string, Promise<ComponentType>>();
const loaded = new Map<string, ComponentType>();

function loadTool(tool: ToolMeta): Promise<ComponentType> {
	let p = loading.get(tool.id);
	if (!p) {
		p = tool.load().then((m) => {
			loaded.set(tool.id, m.default);
			return m.default;
		});
		// A failed fetch (offline, new deploy) may be retried on the next attempt.
		p.catch(() => loading.delete(tool.id));
		loading.set(tool.id, p);
	}
	return p;
}

// Only used when a tool's code hasn't arrived yet (e.g. a direct link): shows the fallback meanwhile.
const lazyTools = new Map<string, ComponentType>(
	tools.map((t) => [t.id, lazy(() => loadTool(t).then((c) => ({ default: c })))]),
);

/**
 * Once the first page is up and the browser is idle, fetch every tool's code (small JS and CSS
 * chunks; workers and WASM still load only when a tool uses them). The first open of a tool is
 * then as instant as the second, on touch screens and direct links too, not just after a hover.
 * Skipped when the visitor asked to save data.
 */
function usePreloadTools(opened: ToolMeta | undefined) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per page load, for the tool it opened on
	useEffect(() => {
		const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
		if (connection?.saveData) return;
		let cancel = () => {};
		let stopped = false;
		const preload = () => {
			for (const t of tools) void loadTool(t).catch(() => {});
		};
		const schedule = () => {
			if (stopped) return;
			if ("requestIdleCallback" in window) {
				const id = requestIdleCallback(preload, { timeout: 3000 });
				cancel = () => cancelIdleCallback(id);
			} else {
				const id = setTimeout(preload, 1500);
				cancel = () => clearTimeout(id);
			}
		};
		// Opened straight on a tool: let its own code arrive first, without competing for bandwidth.
		if (opened) loadTool(opened).then(schedule, schedule);
		else schedule();
		return () => {
			stopped = true;
			cancel();
		};
	}, []);
}

function Logo() {
	return (
		<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
			<rect x="3" y="3" width="12" height="12" rx="3" fill="var(--accent)" />
			<rect x="17" y="3" width="12" height="12" rx="3" fill="var(--border-strong)" />
			<rect x="3" y="17" width="12" height="12" rx="3" fill="var(--border-strong)" />
			<rect x="17" y="17" width="12" height="12" rx="3" fill="var(--accent-soft)" />
		</svg>
	);
}

function useTitle(title: string) {
	useEffect(() => {
		document.title = title;
	}, [title]);
}

function Home() {
	useTitle("Toolbox");
	return (
		<div className={s.home}>
			<section className={s.hero}>
				<p className={s.kicker}>Local-first utilities</p>
				<h1>Small, fast tools that run entirely in your browser.</h1>
				<p className={s.heroLead}>No uploads, no accounts, no limits. Pick a tool to get started.</p>
			</section>
			<ul className={s.grid}>
				{tools.map((t) => (
					<li key={t.id}>
						<ToolCard tool={t} />
					</li>
				))}
			</ul>
		</div>
	);
}

/** How long a click waits on the home page for a tool's code before showing the loading placeholder. */
const HOLD_MS = 1500;

function ToolCard({ tool }: { tool: ToolMeta }) {
	const [, navigate] = useLocation();
	const [opening, setOpening] = useState(false);
	// Warm the tool's code on hover/focus so opening it feels instant.
	const preload = () => void loadTool(tool).catch(() => {});
	// If the code isn't here yet, stay on the home page until it is (briefly), then switch pages
	// in one step: no blank placeholder in between. Modified clicks (new tab etc.) are left alone.
	const open = (e: MouseEvent<HTMLAnchorElement>) => {
		if (loaded.has(tool.id) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		if (opening) return;
		setOpening(true);
		let timer = 0;
		let gone = false;
		const go = () => {
			clearTimeout(timer);
			if (gone) return;
			gone = true;
			navigate(tool.path);
		};
		timer = window.setTimeout(go, HOLD_MS);
		// On failure the page shows the fallback, and the lazy import tries again.
		loadTool(tool).then(go, go);
	};
	return (
		<Link
			href={tool.path}
			className={s.card}
			onMouseEnter={preload}
			onFocus={preload}
			onClick={open}
			aria-busy={opening || undefined}
		>
			<span className={s.cardIcon}>
				<Icon name={tool.icon} size={20} />
			</span>
			<span className={s.cardTitle}>{tool.title}</span>
			<span className={s.cardBlurb}>{tool.blurb}</span>
			<span className={s.tags}>
				{tool.tags.map((tag) => (
					<span key={tag} className={s.tag}>
						{tag}
					</span>
				))}
			</span>
			<Icon name="arrow" size={18} className={s.cardArrow} />
		</Link>
	);
}

function ToolPage({ tool }: { tool: ToolMeta }) {
	useTitle(`${tool.title.replace("⇄", "↔")} · Toolbox`);
	// Code already here (preloaded, hovered, or opened before): render it at once, no Suspense round.
	// Decided once per page: switching from the lazy path to the direct one later (e.g. on a
	// sub-route change) would be a different element tree and remount the tool, losing its state.
	const [Ready] = useState(() => loaded.get(tool.id));
	const Lazy = lazyTools.get(tool.id);
	if (!Ready && !Lazy) return null;
	return (
		<div className={s.toolPage}>
			<Link href="/" className={s.back}>
				<Icon name="back" size={16} /> All tools
			</Link>
			{Ready ? (
				<Ready />
			) : (
				Lazy && (
					<Suspense fallback={<div className={s.loading} aria-busy="true" />}>
						<Lazy />
					</Suspense>
				)
			)}
		</div>
	);
}

function NotFound() {
	useTitle("Not found · Toolbox");
	return (
		<div className={s.notFound}>
			<h1>Nothing here.</h1>
			<Link href="/">Back to all tools</Link>
		</div>
	);
}

export function App() {
	const [location] = useLocation();
	// A tool owns its path and everything below it (e.g. /read/:bookId), staying mounted across sub-routes.
	const tool = tools.find((t) => location === t.path || location.startsWith(`${t.path}/`));
	usePreloadTools(tool);
	// Braces matter: newer browsers return a Promise from scrollTo, and an effect must not return one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to top when switching pages
	useEffect(() => {
		window.scrollTo(0, 0);
	}, [tool?.id ?? location]);

	return (
		<div className={s.shell}>
			<header className={s.header}>
				<Link href="/" className={s.brand}>
					<Logo />
					<span>toolbox</span>
				</Link>
				<span className={s.status}>
					<span className={s.dot} aria-hidden="true" />
					Runs locally
				</span>
			</header>

			<main className={s.main}>
				{location === "/" ? <Home /> : tool ? <ToolPage key={tool.id} tool={tool} /> : <NotFound />}
			</main>

			<footer className={s.footer}>
				<span>Open source under AGPL-3.0</span>
				<a href={SOURCE_URL} target="_blank" rel="noreferrer">
					Source
				</a>
			</footer>
		</div>
	);
}
