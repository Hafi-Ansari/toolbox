import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { detectFile } from "../../lib/detect.ts";
import { formatBytes } from "../../lib/format.ts";
import { Note } from "../../lib/ui.tsx";
import { type Book, openBook } from "./book.ts";
import s from "./EpubReader.module.css";
import { RIcon } from "./icons.tsx";
import {
	addBook,
	clearLibrary,
	coverUrl,
	getBookFile,
	getEntry,
	type LibraryEntry,
	libraryAvailable,
	listBooks,
	type Position,
	removeBook,
} from "./library.ts";
import { Reader } from "./Reader.tsx";

const BASE = "/read";
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Open {
	book: Book;
	entryId: string | null;
	initial?: Position;
}

export default function EpubReaderTool() {
	const [location, navigate] = useLocation();
	const routeId = location.startsWith(`${BASE}/`) ? decodeURIComponent(location.slice(BASE.length + 1)) : null;

	const [open, setOpen] = useState<Open | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [opening, setOpening] = useState(false);
	const [books, setBooks] = useState<LibraryEntry[]>([]);
	const [covers, setCovers] = useState<Record<string, string>>({});
	const [available, setAvailable] = useState<boolean | null>(null);
	const coversRef = useRef(covers);
	coversRef.current = covers;

	const refresh = useCallback(async () => {
		const ok = await libraryAvailable();
		setAvailable(ok);
		if (!ok) return;
		const list = await listBooks();
		setBooks(list);
		const next: Record<string, string> = {};
		for (const b of list) {
			if (!b.hasCover) continue;
			next[b.id] = coversRef.current[b.id] ?? (await coverUrl(b.id)) ?? "";
		}
		for (const [id, url] of Object.entries(coversRef.current)) if (!next[id] && url) URL.revokeObjectURL(url);
		setCovers(next);
	}, []);

	useEffect(() => {
		void refresh();
		return () => {
			for (const url of Object.values(coversRef.current)) if (url) URL.revokeObjectURL(url);
		};
	}, [refresh]);

	async function openFile(file: File) {
		setError(null);
		setOpening(true);
		try {
			const format = await detectFile(file);
			if (format !== "epub")
				throw new Error(
					format === "pdf"
						? "That's a PDF. Use EPUB ⇄ PDF to convert it into an EPUB first."
						: "This doesn't look like an EPUB file.",
				);
			const book = await openBook(file);
			const existing = available ? await getEntry(book.id) : null;
			// Copy into the library in the background; reading starts immediately.
			const stored = available
				? addBook(file, book).catch(() => {
						setError("This book couldn't be saved to your library (storage may be full). You can still read it now.");
						return null;
					})
				: Promise.resolve(null);
			void stored.then(() => refresh());
			setOpen({ book, entryId: available ? book.id : null, initial: existing?.position });
			navigate(`${BASE}/${book.id}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setOpening(false);
		}
	}

	async function openSaved(id: string) {
		setError(null);
		setOpening(true);
		try {
			const file = await getBookFile(id);
			if (!file) throw new Error("That book is no longer in your library. Open the file again.");
			const book = await openBook(file);
			const entry = await getEntry(id);
			void addBook(file, book).then(() => refresh()); // bump "last opened"
			setOpen({ book, entryId: id, initial: entry?.position });
			if (routeId !== id) navigate(`${BASE}/${id}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			navigate(BASE, { replace: true });
		} finally {
			setOpening(false);
		}
	}

	// Keep the URL and the open book in sync (deep links, reloads, browser back).
	// biome-ignore lint/correctness/useExhaustiveDependencies: react to route changes only
	useEffect(() => {
		if (routeId && open?.book.id !== routeId && !opening && available !== null) {
			if (available) void openSaved(routeId);
			else navigate(BASE, { replace: true });
		}
		if (!routeId && open) {
			setOpen(null);
			void refresh();
		}
	}, [routeId, available]);

	const close = useCallback(() => {
		setOpen(null);
		navigate(BASE);
		setTimeout(() => void refresh(), 300); // let the final position save land first
	}, [navigate, refresh]);

	// Drop a book anywhere on the page.
	const [dragging, setDragging] = useState(false);
	const dragDepth = useRef(0);
	const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
	const dropHandlers = {
		onDragEnter: (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			dragDepth.current++;
			setDragging(true);
		},
		onDragOver: (e: DragEvent) => {
			if (hasFiles(e)) e.preventDefault();
		},
		onDragLeave: () => {
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDragging(false);
		},
		onDrop: (e: DragEvent) => {
			e.preventDefault();
			dragDepth.current = 0;
			setDragging(false);
			const file = e.dataTransfer.files[0];
			if (file) void openFile(file);
		},
	};

	if (open && routeId === open.book.id) {
		return <Reader key={open.book.id} book={open.book} entryId={open.entryId} initial={open.initial} onClose={close} />;
	}

	const [recent, ...rest] = books;
	const pct = (b: LibraryEntry) => Math.round((b.position?.percent ?? 0) * 100);
	const remove = async (b: LibraryEntry) => {
		await removeBook(b.id);
		void refresh();
	};
	const coverOf = (b: LibraryEntry, big = false) => (
		<span className={cx(s.cover, big && s.coverBig)}>
			{covers[b.id] ? (
				<img src={covers[b.id]} alt="" loading="lazy" />
			) : (
				<span className={s.placeholder}>
					<span className={s.placeholderLetter}>{b.title.slice(0, 1).toUpperCase()}</span>
					<span className={s.placeholderTitle}>{b.title}</span>
				</span>
			)}
		</span>
	);

	const picker = (
		<input
			type="file"
			accept=".epub,application/epub+zip"
			className={s.fileInput}
			onChange={(e) => {
				const file = e.currentTarget.files?.[0];
				e.currentTarget.value = "";
				if (file) void openFile(file);
			}}
		/>
	);

	return (
		<div className={s.page} {...dropHandlers}>
			{dragging && (
				<div className={s.dropOverlay} aria-hidden="true">
					<span>
						<RIcon name="book" size={28} />
						Drop to start reading
					</span>
				</div>
			)}

			<header className={s.intro}>
				<div className={s.introText}>
					<h1>EPUB Reader</h1>
					<p className={s.lead}>
						Books open instantly, stay on this device, and remember where you left off. Pick a theme, font and text
						color that suit you.
					</p>
				</div>
				{books.length > 0 && (
					// biome-ignore lint/a11y/noLabelWithoutControl: the file input is the {picker} inside
					<label className={s.openBtn}>
						{picker}
						<RIcon name="plus" size={18} />
						{opening ? "Opening…" : "Open book"}
					</label>
				)}
			</header>

			{books.length === 0 && (
				// biome-ignore lint/a11y/noLabelWithoutControl: the file input is the {picker} inside
				<label className={s.drop}>
					{picker}
					<span className={s.dropIcon}>
						<RIcon name="book" size={26} />
					</span>
					<span className={s.dropTitle}>{opening ? "Opening…" : "Open an EPUB"}</span>
					<span className={s.dropHint}>Drop a file here, or click to choose one</span>
				</label>
			)}

			{error && <Note tone="danger">{error}</Note>}
			{available === false && (
				<Note tone="info">
					This browser can't keep books between visits here (private mode or unsupported storage). Reading still works;
					you'll just open the file again next time.
				</Note>
			)}

			{books.length === 0 && (
				<ul className={s.features}>
					<li>
						<strong>Private</strong>
						<span>Books never leave your device. Nothing is uploaded.</span>
					</li>
					<li>
						<strong>Yours to style</strong>
						<span>Five themes, six fonts, any text color, boldness, spacing and margins.</span>
					</li>
					<li>
						<strong>Picks up where you left off</strong>
						<span>Your place is saved as you read, even if you change the text size.</span>
					</li>
				</ul>
			)}

			{recent && (
				<section className={s.continue} aria-labelledby="continue-heading">
					<h2 id="continue-heading" className={s.sectionTitle}>
						Continue reading
					</h2>
					<div className={s.hero}>
						<button type="button" className={s.heroOpen} onClick={() => openSaved(recent.id)} disabled={opening}>
							<span className={s.heroTitle}>{recent.title}</span>
							{coverOf(recent, true)}
							<span className={s.heroBody}>
								{recent.author && <span className={s.heroAuthor}>{recent.author}</span>}
								<span className={s.heroProgress}>
									<span className={s.bar}>
										<span style={{ width: `${pct(recent)}%` }} />
									</span>
									<span>{pct(recent) > 0 ? `${pct(recent)}% read` : "Not started"}</span>
								</span>
								<span className={s.heroCta}>
									{pct(recent) > 0 ? "Continue" : "Start reading"}
									<RIcon name="chevron-right" size={16} />
								</span>
							</span>
						</button>
						<button
							type="button"
							className={s.remove}
							aria-label={`Remove ${recent.title} from this device`}
							title="Remove from this device"
							onClick={() => void remove(recent)}
						>
							<RIcon name="x" size={14} />
						</button>
					</div>
				</section>
			)}

			{rest.length > 0 && (
				<section className={s.library} aria-labelledby="library-heading">
					<div className={s.libraryHead}>
						<h2 id="library-heading" className={s.sectionTitle}>
							Library
						</h2>
						<span className={s.libraryMeta}>
							{books.length} books · {formatBytes(books.reduce((n, b) => n + b.size, 0))} on this device
						</span>
					</div>
					<ul className={s.grid}>
						{rest.map((b) => (
							<li key={b.id} className={s.book}>
								<button type="button" className={s.bookOpen} onClick={() => openSaved(b.id)} disabled={opening}>
									<span className={s.bookTitle}>{b.title}</span>
									{coverOf(b)}
									{b.author && <span className={s.bookAuthor}>{b.author}</span>}
									<span className={s.bookProgress}>
										<span className={s.bar}>
											<span style={{ width: `${pct(b)}%` }} />
										</span>
										<span>{pct(b) > 0 ? `${pct(b)}%` : "New"}</span>
									</span>
								</button>
								<button
									type="button"
									className={s.remove}
									aria-label={`Remove ${b.title} from this device`}
									title="Remove from this device"
									onClick={() => void remove(b)}
								>
									<RIcon name="x" size={14} />
								</button>
							</li>
						))}
					</ul>
				</section>
			)}

			{books.length > 0 && (
				<div className={s.footerActions}>
					<button
						type="button"
						className={s.textBtn}
						onClick={async () => {
							if (!window.confirm("Remove all books from this device?")) return;
							await clearLibrary();
							void refresh();
						}}
					>
						<RIcon name="trash" size={15} />
						Clear library
					</button>
				</div>
			)}
		</div>
	);
}
