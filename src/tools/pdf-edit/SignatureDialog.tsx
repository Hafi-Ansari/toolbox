import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Button, Note } from "../../lib/ui.tsx";
import { StrokeArt } from "./Artwork.tsx";
import { SANS, SCRIPT } from "./fonts.ts";
import type { Point } from "./geometry.ts";
import { type Asset, IMAGE_ACCEPT, readImage } from "./images.ts";
import { clamp, normalizeStrokes, type Signature, type Strokes } from "./items.ts";
import s from "./PdfEdit.module.css";

type Preset = Exclude<Signature, { kind: "image" }> | { kind: "image"; src: string; w: number; h: number };
type Saved = Preset & { id: string };
const STORAGE = "toolbox.pdf-edit.signatures";
const MAX_STORAGE = 1_500_000;

function validPreset(value: unknown): value is Saved {
	if (!value || typeof value !== "object" || !("kind" in value) || !("id" in value) || typeof value.id !== "string")
		return false;
	if (value.kind === "typed") return "text" in value && typeof value.text === "string";
	if (value.kind === "image") {
		return (
			"src" in value &&
			typeof value.src === "string" &&
			/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value.src) &&
			"w" in value &&
			"h" in value &&
			typeof value.w === "number" &&
			typeof value.h === "number" &&
			value.w > 0 &&
			value.h > 0
		);
	}
	return (
		value.kind === "drawn" &&
		"ratio" in value &&
		typeof value.ratio === "number" &&
		value.ratio > 0 &&
		"strokes" in value &&
		Array.isArray(value.strokes) &&
		value.strokes.every(
			(stroke) =>
				Array.isArray(stroke) &&
				stroke.every(
					(point) =>
						Array.isArray(point) && point.length === 2 && point.every((n) => Number.isFinite(n) && n >= 0 && n <= 1),
				),
		)
	);
}

function readSaved(): Saved[] {
	try {
		const text = localStorage.getItem(STORAGE);
		if (!text || text.length > MAX_STORAGE) return [];
		const list: unknown = JSON.parse(text);
		return Array.isArray(list) ? list.filter(validPreset) : [];
	} catch {
		return [];
	}
}

function saveList(list: Saved[]) {
	const json = JSON.stringify(list);
	if (json.length > MAX_STORAGE)
		throw new Error(
			"This signature is too large to save on this device. Uncheck Remember on this device to place it once.",
		);
	localStorage.setItem(STORAGE, json);
}

function assetFromPreset(preset: Extract<Preset, { kind: "image" }>): Asset {
	return {
		data: Uint8Array.from(atob(preset.src.slice("data:image/png;base64,".length)), (c) => c.charCodeAt(0)),
		...preset,
	};
}

function SignaturePreview({ preset }: { preset: Preset }) {
	if (preset.kind === "typed")
		return (
			<span className={s.script} style={{ fontFamily: `"${SCRIPT}", "${SANS}"` }}>
				{preset.text}
			</span>
		);
	if (preset.kind === "image") return <img src={preset.src} alt="" className={s.signatureImage} />;
	return (
		<svg aria-hidden="true" viewBox={`0 0 ${80 * preset.ratio} 80`} className={s.signatureImage}>
			<StrokeArt strokes={preset.strokes} w={80 * preset.ratio} h={80} color="#15212b" width={3} />
		</svg>
	);
}

export function SignatureDialog({
	onClose,
	onChoose,
}: {
	onClose: () => void;
	onChoose: (source: Signature, asset?: Asset) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const fileRequest = useRef(0);
	const pointer = useRef<number | null>(null);
	const points = useRef<Strokes>([]);
	const [tab, setTab] = useState<"drawn" | "typed" | "image">("drawn");
	const [saved, setSaved] = useState(readSaved);
	const [strokes, setStrokes] = useState<Strokes>([]);
	const [text, setText] = useState("");
	const [file, setFile] = useState<File>();
	const [image, setImage] = useState<Asset>();
	const [transparent, setTransparent] = useState(false);
	const [remember, setRemember] = useState(false);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const padWidth = 320;
	const padHeight = 124;

	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => element?.close();
	}, []);

	function coords(e: PointerEvent<HTMLDivElement>): Point {
		const rect = e.currentTarget.getBoundingClientRect();
		return [clamp((e.clientX - rect.left) / rect.width, 0, 1), clamp((e.clientY - rect.top) / rect.height, 0, 1)];
	}

	function draw(e: PointerEvent<HTMLDivElement>) {
		if (pointer.current !== e.pointerId) return;
		const last = points.current.at(-1);
		if (!last) return;
		last.push(coords(e));
		setStrokes(points.current.map((stroke) => [...stroke]));
	}

	async function upload(next: File, removeWhite: boolean) {
		const id = ++fileRequest.current;
		setFile(next);
		setImage(undefined);
		setError("");
		setWorking(true);
		try {
			const result = await readImage(next, removeWhite);
			if (id === fileRequest.current) setImage(result);
		} catch (err) {
			if (id === fileRequest.current) setError(err instanceof Error ? err.message : "The image could not be opened.");
		} finally {
			if (id === fileRequest.current) setWorking(false);
		}
	}

	function choose(preset: Preset) {
		if (preset.kind === "image") {
			const asset = assetFromPreset(preset);
			onChoose({ kind: "image", key: crypto.randomUUID(), ratio: asset.w / asset.h }, asset);
		} else onChoose(preset);
	}

	function submit() {
		let preset: Preset;
		if (tab === "typed") {
			if (!text.trim()) return;
			preset = { kind: "typed", text: text.trim().normalize("NFC") };
		} else if (tab === "image") {
			if (!image) return;
			preset = { kind: "image", src: image.src, w: image.w, h: image.h };
		} else {
			if (!strokes.length) return;
			const cropped = normalizeStrokes(
				strokes.map((line) => line.map(([x, y]) => [x * padWidth, y * padHeight])),
				5,
			);
			preset = { kind: "drawn", strokes: cropped.strokes, ratio: cropped.w / cropped.h };
		}
		if (remember) {
			try {
				saveList([...saved, { ...preset, id: crypto.randomUUID() }]);
			} catch (err) {
				setError(err instanceof Error ? err.message : "This device could not remember the signature.");
				return;
			}
		}
		choose(preset);
	}

	function remove(id: string) {
		const list = saved.filter((entry) => entry.id !== id);
		try {
			saveList(list);
			setSaved(list);
			setError("");
		} catch {
			setError("This device could not remove the saved signature.");
		}
	}
	const empty = tab === "drawn" ? !strokes.length : tab === "typed" ? !text.trim() : !image;

	return (
		<dialog
			ref={dialog}
			className={s.dialog}
			aria-labelledby="signature-editor-title"
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
		>
			<header className={s.dialogHeader}>
				<h2 id="signature-editor-title">Add signature</h2>
				<Button variant="ghost" icon="x" aria-label="Close signature dialog" onClick={onClose} />
			</header>
			<fieldset className={s.tabs} aria-label="Signature method">
				{(
					[
						["drawn", "Draw"],
						["typed", "Type"],
						["image", "Upload"],
					] as const
				).map(([kind, name]) => (
					<button
						type="button"
						key={kind}
						aria-pressed={tab === kind}
						onClick={() => {
							setTab(kind);
							setError("");
						}}
					>
						{name}
					</button>
				))}
			</fieldset>
			{tab === "drawn" ? (
				<>
					<div
						className={s.pad}
						role="img"
						aria-label="Signature drawing pad"
						onPointerDown={(e) => {
							if (pointer.current !== null || !e.isPrimary || e.button !== 0) return;
							pointer.current = e.pointerId;
							points.current.push([coords(e)]);
							setStrokes([...points.current]);
							e.currentTarget.setPointerCapture(e.pointerId);
						}}
						onPointerMove={draw}
						onPointerUp={(e) => {
							draw(e);
							pointer.current = null;
						}}
						onPointerCancel={() => {
							pointer.current = null;
						}}
					>
						<svg aria-hidden="true" viewBox={`0 0 ${padWidth} ${padHeight}`}>
							<StrokeArt strokes={strokes} w={padWidth} h={padHeight} width={2.5} color="#15212b" />
						</svg>
					</div>
					<Button
						variant="ghost"
						disabled={!strokes.length}
						onClick={() => {
							points.current = [];
							setStrokes([]);
						}}
					>
						Clear drawing
					</Button>
				</>
			) : tab === "typed" ? (
				<div className={s.signatureFields}>
					<label>
						Signature text <input type="text" maxLength={80} value={text} onChange={(e) => setText(e.target.value)} />
					</label>
					{text.trim() && (
						<div className={s.signaturePreview}>
							<SignaturePreview preset={{ kind: "typed", text }} />
						</div>
					)}
				</div>
			) : (
				<div className={s.signatureFields}>
					<label>
						Signature image{" "}
						<input
							type="file"
							accept={IMAGE_ACCEPT}
							onChange={(e) => {
								const selected = e.target.files?.[0];
								if (selected) void upload(selected, transparent);
							}}
						/>
					</label>
					<label className={s.checkbox}>
						<input
							type="checkbox"
							checked={transparent}
							onChange={(e) => {
								setTransparent(e.target.checked);
								if (file) void upload(file, e.target.checked);
							}}
						/>
						Make white transparent
					</label>
					{working && <p role="status">Opening image…</p>}
					{image && (
						<div className={s.signaturePreview}>
							<SignaturePreview preset={{ kind: "image", src: image.src, w: image.w, h: image.h }} />
						</div>
					)}
				</div>
			)}
			{error && <Note tone="danger">{error}</Note>}
			<label className={s.checkbox}>
				<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
				Remember on this device
			</label>
			<Button disabled={empty || working} onClick={submit}>
				Use signature
			</Button>
			{saved.length > 0 && (
				<section className={s.saved}>
					<h3>Saved signatures</h3>
					{saved.map((entry) => (
						<div key={entry.id} className={s.savedRow}>
							<button
								className={s.signaturePreview}
								type="button"
								aria-label={
									entry.kind === "typed" ? `Use saved signature ${entry.text}` : `Use saved ${entry.kind} signature`
								}
								onClick={() => choose(entry)}
							>
								<SignaturePreview preset={entry} />
							</button>
							<Button variant="ghost" icon="x" aria-label="Remove saved signature" onClick={() => remove(entry.id)} />
						</div>
					))}
				</section>
			)}
		</dialog>
	);
}
