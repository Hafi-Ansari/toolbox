import type { Entry } from "./listing.ts";

export interface EntrySink {
	start(index: number): void;
	write(chunk: Uint8Array): void;
	end(): void;
}

/** 7-Zip writes plain file bodies consecutively in archive order. */
export function splitOutput(entries: Entry[], indexes: number[], sink: EntrySink) {
	let position = 0;
	let written = 0;
	let started = false;
	const advance = () => {
		while (position < indexes.length && entries[indexes[position]].size === 0) {
			sink.start(indexes[position]);
			sink.end();
			position++;
		}
	};
	return {
		write(chunk: Uint8Array) {
			let at = 0;
			while (at < chunk.length) {
				advance();
				if (position === indexes.length) throw new Error("Archive headers don't match the extracted contents.");
				const index = indexes[position];
				if (!started) {
					sink.start(index);
					started = true;
				}
				const count = Math.min(chunk.length - at, entries[index].size - written);
				sink.write(chunk.subarray(at, at + count));
				at += count;
				written += count;
				if (written === entries[index].size) {
					sink.end();
					position++;
					written = 0;
					started = false;
				}
			}
		},
		finish() {
			advance();
			if (position !== indexes.length) throw new Error("Archive headers don't match the extracted contents.");
		},
	};
}
