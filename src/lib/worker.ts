// Starts a Comlink worker and waits for its "ready" signal, which it sends once
// heavy setup (like compiling WASM) is done. terminate() cancels instantly.
import * as Comlink from "comlink";

export interface WorkerHandle<T> {
	api: Promise<Comlink.Remote<T>>;
	terminate(): void;
}

export function startWorker<T>(create: () => Worker): WorkerHandle<T> {
	const worker = create();
	const api = new Promise<Comlink.Remote<T>>((resolve, reject) => {
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === "ready") {
				worker.removeEventListener("message", onMessage);
				resolve(Comlink.wrap<T>(worker));
			}
		};
		worker.addEventListener("message", onMessage);
		worker.addEventListener("error", (e) => reject(new Error(e.message || "The converter failed to load.")), {
			once: true,
		});
	});
	return { api, terminate: () => worker.terminate() };
}
