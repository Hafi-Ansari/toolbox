import { type ComponentType, lazy, Suspense, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Icon } from "../lib/Icon.tsx";
import { type ToolMeta, tools } from "../tools/registry.ts";
import s from "./App.module.css";
import { SOURCE_URL } from "./config.ts";

// One lazy component per tool, created once.
const lazyTools = new Map<string, ComponentType>(tools.map((t) => [t.id, lazy(t.load)]));

/**
 * Once the first page is up and the browser is idle, fetch every tool's code (small JS and CSS
 * chunks; workers and WASM still load only when a tool uses them). The first open of a tool is
 * then as instant as the second, on touch screens and direct links too, not just after a hover.
 * Skipped when the visitor asked to save data.
 */
function usePreloadTools() {
	useEffect(() => {
		const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
		if (connection?.saveData) return;
		const preload = () => {
			for (const t of tools) void t.load().catch(() => {});
		};
		if ("requestIdleCallback" in window) {
			const id = requestIdleCallback(preload, { timeout: 3000 });
			return () => cancelIdleCallback(id);
		}
		const id = setTimeout(preload, 1500);
		return () => clearTimeout(id);
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

function ToolCard({ tool }: { tool: ToolMeta }) {
	// Warm the tool's code on hover/focus so opening it feels instant.
	const preload = () => void tool.load();
	return (
		<Link href={tool.path} className={s.card} onMouseEnter={preload} onFocus={preload}>
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
	const Component = lazyTools.get(tool.id);
	if (!Component) return null;
	return (
		<div className={s.toolPage}>
			<Link href="/" className={s.back}>
				<Icon name="back" size={16} /> All tools
			</Link>
			<Suspense fallback={<div className={s.loading} aria-busy="true" />}>
				<Component />
			</Suspense>
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
	usePreloadTools();
	// A tool owns its path and everything below it (e.g. /read/:bookId), staying mounted across sub-routes.
	const tool = tools.find((t) => location === t.path || location.startsWith(`${t.path}/`));
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
