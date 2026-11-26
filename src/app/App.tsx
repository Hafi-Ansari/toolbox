import { type ComponentType, lazy, Suspense, useEffect } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { Icon } from "../lib/Icon.tsx";
import { type ToolMeta, tools } from "../tools/registry.ts";
import s from "./App.module.css";
import { SOURCE_URL } from "./config.ts";

// One lazy component per tool, created once.
const lazyTools = new Map<string, ComponentType>(tools.map((t) => [t.id, lazy(t.load)]));

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
	// Braces matter: newer browsers return a Promise from scrollTo, and an effect must not return one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to top on every navigation
	useEffect(() => {
		window.scrollTo(0, 0);
	}, [location]);

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
				<Switch>
					<Route path="/">
						<Home />
					</Route>
					{tools.map((t) => (
						<Route key={t.id} path={t.path}>
							<ToolPage tool={t} />
						</Route>
					))}
					<Route>
						<NotFound />
					</Route>
				</Switch>
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
