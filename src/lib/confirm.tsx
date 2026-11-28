// An in-page confirmation, in place of the browser's window.confirm(): same look as the rest of
// the app, keyboard friendly (Esc and a click outside cancel), and promise-based so call sites
// stay one line: `if (!(await confirm({ ... }))) return;`
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import s from "./confirm.module.css";

export interface ConfirmOptions {
	title: string;
	message?: string;
	/** Label of the confirming button. */
	confirmLabel: string;
	cancelLabel?: string;
	/** "danger" for actions that delete or discard something. */
	tone?: "danger" | "default";
}

let current: (() => void) | null = null;

/** Shows the confirmation; resolves true when confirmed, false when cancelled or dismissed. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
	current?.(); // only one at a time: a new question cancels the previous one
	return new Promise((resolve) => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		let settled = false;
		const settle = (ok: boolean, now = false) => {
			if (settled) return;
			settled = true;
			if (current === cancel) current = null;
			resolve(ok);
			// Unmount once the fade-out (confirm.module.css) has played; at once when replaced.
			setTimeout(
				() => {
					root.unmount();
					host.remove();
				},
				now ? 0 : 200,
			);
		};
		const cancel = () => settle(false, true);
		current = cancel;
		root.render(<ConfirmDialog {...options} onDone={settle} />);
	});
}

function ConfirmDialog({
	title,
	message,
	confirmLabel,
	cancelLabel = "Cancel",
	tone = "default",
	onDone,
}: ConfirmOptions & { onDone: (ok: boolean) => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		d.showModal();
		// Safer default for destructive questions: Enter cancels unless the user moves to confirm.
		(tone === "danger" ? cancelRef.current : d.querySelector<HTMLButtonElement>("[data-confirm]"))?.focus();
		const onClose = () => {
			// While it fades out it's still painted: keep it out of reach and out of the accessibility tree.
			d.inert = true;
			d.setAttribute("aria-hidden", "true");
			onDone(d.returnValue === "yes");
		};
		d.addEventListener("close", onClose);
		return () => d.removeEventListener("close", onClose);
	}, [onDone, tone]);

	// Close at once, so the page is usable again immediately; CSS fades the panel out afterwards.
	const close = (value: "yes" | "no") => {
		const d = ref.current;
		if (!d?.open) return;
		d.inert = true;
		d.setAttribute("aria-hidden", "true");
		d.close(value);
	};

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a mouse shortcut; keyboards have Esc (onCancel)
		<dialog
			ref={ref}
			className={s.dialog}
			aria-labelledby="confirm-title"
			// Esc fires "cancel"; make it close through the same path so the result is "no".
			onCancel={(e) => {
				e.preventDefault();
				close("no");
			}}
			// A click on the backdrop lands on the <dialog> itself, outside the panel.
			onClick={(e) => e.target === ref.current && close("no")}
		>
			<div className={s.panel}>
				<h2 id="confirm-title" className={s.title}>
					{title}
				</h2>
				{message && <p className={s.message}>{message}</p>}
				<div className={s.actions}>
					<button ref={cancelRef} type="button" className={`${s.button} ${s.cancel}`} onClick={() => close("no")}>
						{cancelLabel}
					</button>
					<button
						type="button"
						data-confirm=""
						className={`${s.button} ${tone === "danger" ? s.danger : s.primary}`}
						onClick={() => close("yes")}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</dialog>
	);
}
