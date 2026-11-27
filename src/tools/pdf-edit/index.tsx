import type { Remote } from "comlink";
import { useEffect, useRef, useState } from "react";
import { detectFile } from "../../lib/detect.ts";
import { formatBytes } from "../../lib/format.ts";
import { Button, Card, Chip, FileDrop, Note, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import { Editor } from "./Editor.tsx";
import type { EditApi, OpenDocument } from "./edit.worker.ts";
import { Password } from "./Password.tsx";
import s from "./PdfEdit.module.css";

type State =
	| { kind: "idle" }
	| { kind: "opening"; file: File }
	| { kind: "locked"; file: File; previous: boolean }
	| { kind: "error"; file: File; message: string }
	| { kind: "ready"; file: File; doc: OpenDocument; api: Remote<EditApi> };

export default function PdfEditorTool() {
	const [state, setState] = useState<State>({ kind: "idle" });
	const worker = useRef<WorkerHandle<EditApi> | null>(null);
	const run = useRef(0);

	useEffect(
		() => () => {
			run.current++;
			worker.current?.terminate();
			worker.current = null;
		},
		[],
	);

	function reset() {
		run.current++;
		worker.current?.terminate();
		worker.current = null;
		setState({ kind: "idle" });
	}

	async function open(file: File, password?: string) {
		const id = ++run.current;
		setState({ kind: "opening", file });
		try {
			if (password === undefined && (await detectFile(file)) !== "pdf") throw new Error("Choose a PDF file to edit.");
			if (id !== run.current) return;
			worker.current ??= startWorker<EditApi>(
				() => new Worker(new URL("./edit.worker.ts", import.meta.url), { type: "module" }),
			);
			const api = await worker.current.api;
			const doc = await api.open(file, password);
			if (id !== run.current) return;
			setState(doc ? { kind: "ready", file, doc, api } : { kind: "locked", file, previous: password !== undefined });
		} catch (error) {
			if (id !== run.current) return;
			setState({
				kind: "error",
				file,
				message: error instanceof Error ? error.message : "This PDF could not be opened.",
			});
		}
	}

	return (
		<div className={state.kind === "ready" ? `${s.page} ${s.ready}` : s.page}>
			<header className={s.intro}>
				<h1>PDF Editor</h1>
				{state.kind !== "ready" && (
					<p>Add text, draw, sign, and place images on a PDF. Everything stays on this device.</p>
				)}
			</header>
			<Card className={s.panel}>
				{state.kind === "idle" ? (
					<FileDrop
						accept=".pdf,application/pdf"
						title="Drop a PDF"
						hint="or click to choose a file"
						onFile={(file) => void open(file)}
					/>
				) : state.kind === "ready" ? (
					<Editor file={state.file} doc={state.doc} api={state.api} reset={reset} />
				) : (
					<div className={s.workspace}>
						<div className={s.fileRow}>
							<Chip badge="PDF" name={state.file.name} meta={formatBytes(state.file.size)} />
							<Button variant="ghost" icon="x" onClick={reset}>
								{state.kind === "opening" ? "Cancel" : "Change file"}
							</Button>
						</div>
						{state.kind === "locked" ? (
							<Password
								file={state.file}
								previous={state.previous}
								open={(file, password) => void open(file, password)}
							/>
						) : state.kind === "error" ? (
							<Note tone="danger">{state.message}</Note>
						) : (
							<Progress value={0} max={0} label="Opening PDF…" />
						)}
					</div>
				)}
			</Card>
		</div>
	);
}
