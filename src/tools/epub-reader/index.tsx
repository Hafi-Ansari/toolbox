import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { detectFile } from "../../lib/detect.ts";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { Button, FileDrop, Note } from "../../lib/ui.tsx";
import { type Book, openBook } from "./book.ts";
import s from "./EpubReader.module.css";
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

	if (open && routeId === open.book.id) {
		return <Reader key={open.book.id} book={open.book} entryId={open.entryId} initial={open.initial} onClose={close} />;
	}

	return (
		<div className={s.page}>
			<header className={s.intro}>
				<h1>EPUB Reader</h1>
				<p className={s.lead}>
					Open an ebook and read it in a calm dark theme. Books open instantly, stay on this device, and remember where
					you left off.
				</p>
			</header>

			<FileDrop
				accept=".epub,application/epub+zip"
				title={opening ? "Opening…" : "Drop an EPUB to read"}
				hint="or click to choose a file"
				onFile={openFile}
			/>

			{error && <Note tone="danger">{error}</Note>}
			{available === false && (
				<Note tone="info">
					This browser can't keep books between visits here (private mode or unsupported storage). Reading still works;
					you'll just open the file again next time.
				</Note>
			)}

			{books.length > 0 && (
				<section className={s.library} aria-labelledby="recent-heading">
					<div className={s.libraryHead}>
						<h2 id="recent-heading">Recent</h2>
						<span className={s.libraryMeta}>
							{books.length} {books.length === 1 ? "book" : "books"} ·{" "}
							{formatBytes(books.reduce((n, b) => n + b.size, 0))} on this device
						</span>
					</div>
					<ul className={s.grid}>
						{books.map((b) => {
							const pct = Math.round((b.position?.percent ?? 0) * 100);
							return (
								<li key={b.id} className={s.book}>
									<button type="button" className={s.bookOpen} onClick={() => openSaved(b.id)} disabled={opening}>
										<span className={s.cover}>
											{covers[b.id] ? (
												<img src={covers[b.id]} alt="" loading="lazy" />
											) : (
												<span className={s.placeholder}>{b.title.slice(0, 1).toUpperCase()}</span>
											)}
										</span>
										<span className={s.bookTitle}>{b.title}</span>
										{b.author && <span className={s.bookAuthor}>{b.author}</span>}
										<span className={s.bookProgress}>
											<span className={s.bar}>
												<span style={{ width: `${pct}%` }} />
											</span>
											<span>{pct > 0 ? `${pct}%` : "New"}</span>
										</span>
									</button>
									<button
										type="button"
										className={s.remove}
										aria-label={`Remove ${b.title} from this device`}
										title="Remove from this device"
										onClick={async () => {
											await removeBook(b.id);
											void refresh();
										}}
									>
										<Icon name="x" size={14} />
									</button>
								</li>
							);
						})}
					</ul>
					<div>
						<Button
							variant="ghost"
							onClick={async () => {
								if (!window.confirm("Remove all books from this device?")) return;
								await clearLibrary();
								void refresh();
							}}
						>
							Clear library
						</Button>
					</div>
				</section>
			)}
		</div>
	);
}
