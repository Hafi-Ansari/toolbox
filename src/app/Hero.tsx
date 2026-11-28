// The home page's hero: what Toolbox is, in one line, beside a live panel that shows real jobs
// running (a lecture becoming timestamped lines, an iPhone photo becoming a JPEG…), each naming
// the engine that does it on this device. The panel opens the tool it shows.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Icon } from "../lib/Icon.tsx";
import { type ToolMeta, tools } from "../tools/registry.ts";
import { SOURCE_URL } from "./config.ts";
import { FlowLines } from "./FlowLines.tsx";
import s from "./Hero.module.css";

interface Scene {
	tool: string;
	/** Shown in the panel's title bar; deliberately not the tool's own title. */
	label: string;
	input: { badge: string; name: string; meta: string };
	engine: string;
	output: { badge: string; name: string };
	lines: string[];
	mono?: boolean;
}

const SCENES: Scene[] = [
	{
		tool: "transcribe",
		label: "Transcribing a lecture",
		input: { badge: "MP4", name: "lecture.mp4", meta: "1.2 GB" },
		engine: "Whisper · WebGPU",
		output: { badge: "TXT", name: "lecture.txt" },
		lines: [
			"[00:00:00] Okay, the recording is on.",
			"[00:00:04] Today we look at how models learn.",
			"[00:00:11] Let's start with a simple question.",
		],
		mono: true,
	},
	{
		tool: "photo",
		label: "Converting iPhone photos",
		input: { badge: "HEIC", name: "IMG_2041.HEIC", meta: "3.1 MB" },
		engine: "libheif · WebAssembly",
		output: { badge: "JPG", name: "IMG_2041.jpg" },
		lines: ["4032 × 3024, Display P3 colors kept", "Date and camera kept", "Location removed"],
	},
	{
		tool: "pdf-edit",
		label: "Signing a PDF",
		input: { badge: "PDF", name: "lease.pdf", meta: "12 pages" },
		engine: "MuPDF · WebAssembly",
		output: { badge: "PDF", name: "lease (signed).pdf" },
		lines: ["Signature placed on page 12", "Form fields filled in", "The original is left untouched"],
	},
	{
		tool: "pdf-txt",
		label: "Lifting text from a book of poems",
		input: { badge: "PDF", name: "poems.pdf", meta: "64 pages" },
		engine: "MuPDF · WebAssembly",
		output: { badge: "TXT", name: "poems.txt" },
		lines: ["Lantern Weather", "The ferry keeps its own small light,", "a coin of yellow on the tide,"],
	},
	{
		tool: "file-transfer",
		label: "Sending a folder to a phone",
		input: { badge: "DIR", name: "Vacation", meta: "1,204 files · 4.8 GB" },
		engine: "WebRTC · 6 lanes",
		output: { badge: "ZIP", name: "Vacation.zip" },
		lines: ["Straight to the other device", "61 MB/s over Wi-Fi", "Never stored on a server"],
	},
];

const SCENE_MS = 5200;

/** Isolated tools need a full page load (their own headers); the rest open in place. */
function ToolAnchor({
	tool,
	className,
	label,
	children,
}: {
	tool: ToolMeta;
	className: string;
	label: string;
	children: ReactNode;
}) {
	return tool.isolated ? (
		<a href={tool.path} className={className} aria-label={label}>
			{children}
		</a>
	) : (
		<Link href={tool.path} className={className} aria-label={label}>
			{children}
		</Link>
	);
}

function LivePanel({ panelRef }: { panelRef: React.RefObject<HTMLDivElement | null> }) {
	const scenes = SCENES.filter((sc) => tools.some((t) => t.id === sc.tool));
	const [index, setIndex] = useState(0);
	const [paused, setPaused] = useState(false);
	const [still] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);

	// biome-ignore lint/correctness/useExhaustiveDependencies: each new scene restarts the timer
	useEffect(() => {
		if (paused || still) return;
		const id = window.setTimeout(() => setIndex((i) => (i + 1) % scenes.length), SCENE_MS);
		return () => clearTimeout(id);
	}, [index, paused, still, scenes.length]);

	const scene = scenes[index];
	const tool = tools.find((t) => t.id === scene.tool) as ToolMeta;
	return (
		<section
			className={s.panelWrap}
			aria-label="Toolbox at work"
			onPointerEnter={() => setPaused(true)}
			onPointerLeave={() => setPaused(false)}
			onFocus={() => setPaused(true)}
			onBlur={() => setPaused(false)}
		>
			<div className={s.panelGlow} aria-hidden="true" />
			<div className={s.panel} ref={panelRef}>
				<div className={s.titleBar}>
					<span className={s.lights} aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
					<span className={s.titleText}>on this device</span>
					<span className={s.live}>
						<span className={s.liveDot} aria-hidden="true" />
						live
					</span>
				</div>
				<ToolAnchor tool={tool} className={s.stage} label={`Try it: ${scene.label.toLowerCase()}`}>
					{/* key: every scene replays its entrance animations from the start */}
					<div key={index} className={s.scene} aria-live="polite">
						<p className={s.sceneLabel}>{scene.label}</p>
						<div className={s.flowRow}>
							<FileChip badge={scene.input.badge} name={scene.input.name} meta={scene.input.meta} />
							<div className={s.pipe}>
								<div className={s.pipeTrack}>
									<div className={s.pipeFill} />
								</div>
							</div>
							<div className={s.out}>
								<FileChip badge={scene.output.badge} name={scene.output.name} meta="ready" accent />
							</div>
						</div>
						<p className={s.engine}>
							<span className={s.engineSpin} aria-hidden="true" />
							<span>
								via <b>{scene.engine}</b>, on this device
							</span>
						</p>
						<ul className={scene.mono ? `${s.lines} ${s.mono}` : s.lines}>
							{scene.lines.map((line, i) => (
								<li key={line} style={{ "--i": i } as React.CSSProperties}>
									<Line text={line} />
								</li>
							))}
						</ul>
						<span className={s.open}>
							Open {tool.title} <Icon name="arrow" size={14} />
						</span>
					</div>
				</ToolAnchor>
				<div className={s.dots}>
					{scenes.map((sc, i) => (
						<button
							key={sc.tool}
							type="button"
							className={i === index ? `${s.dot} ${s.dotOn}` : s.dot}
							aria-label={`Show: ${sc.label.toLowerCase()}`}
							aria-pressed={i === index}
							onClick={() => setIndex(i)}
						>
							{i === index && !paused && !still && <span className={s.dotTimer} />}
						</button>
					))}
				</div>
			</div>
		</section>
	);
}

/** "[00:00:04] text": the timestamp in the accent color, as in the transcript view. */
function Line({ text }: { text: string }) {
	const m = /^(\[\d\d:\d\d:\d\d\]) (.*)$/.exec(text);
	if (!m) return <>{text}</>;
	return (
		<>
			<span className={s.ts}>{m[1]}</span> {m[2]}
		</>
	);
}

function FileChip({ badge, name, meta, accent }: { badge: string; name: string; meta: string; accent?: boolean }) {
	return (
		<div className={accent ? `${s.chip} ${s.chipOut}` : s.chip}>
			<span className={s.badge}>{badge}</span>
			<span className={s.chipText}>
				<span className={s.chipName}>{name}</span>
				<span className={s.chipMeta}>{meta}</span>
			</span>
		</div>
	);
}

export function Hero() {
	const panelRef = useRef<HTMLDivElement>(null);
	return (
		<section className={s.hero}>
			<FlowLines focus={panelRef} />
			<div className={s.copy}>
				<p className={s.kicker}>
					<span className={s.kickerDot} aria-hidden="true" />
					Open source · runs on your device
				</p>
				<h1 className={s.title}>
					Your files, transformed <span className={s.shine}>right in your browser.</span>
				</h1>
				<p className={s.lead}>
					Convert ebooks and photos, edit and sign PDFs, transcribe video, and send files to your other devices.
					WebAssembly and WebGPU do the work on your own machine: no uploads, no accounts, no queue.
				</p>
				<div className={s.actions}>
					<a href="#tools" className={s.primary}>
						Browse the tools <Icon name="arrow" size={16} className={s.down} />
					</a>
					<a href={SOURCE_URL} target="_blank" rel="noreferrer" className={s.secondary}>
						<Icon name="code" size={16} /> View source
					</a>
				</div>
				<ul className={s.facts}>
					<li>
						<strong>{tools.length}</strong> tools
					</li>
					<li>
						<strong>0</strong> uploads
					</li>
					<li>
						<strong>AGPL</strong> open source
					</li>
				</ul>
			</div>
			<LivePanel panelRef={panelRef} />
		</section>
	);
}
