// The exact byte length of the archive `ZipWriter.addStream` + `finish()` writes for these entries
// (SPEC §8.2), so the service worker can send an exact Content-Length before any byte exists.
// zipSize.test.ts checks it against real writer output; keep the two in step.
import { EXTENDED_TIME_EXTRA } from "../../../lib/zipWriter.ts";

export interface ZipEntrySpec {
	/** The entry name exactly as passed to `addStream` (already sanitized). */
	name: string;
	size: number;
	/** As passed to `addStream`: present ⇒ an extended-timestamp extra field is written. */
	modified?: number;
}

const MAX32 = 0xffffffff;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const EOCD = 22;
const ZIP64_EOCD_AND_LOCATOR = 56 + 20;

const enc = new TextEncoder();

/** Bytes of a store-only, data-descriptor, ZIP64-when-needed archive of `entries`, in order. */
export function zipSize(entries: readonly ZipEntrySpec[]): number {
	let offset = 0;
	let central = 0;
	for (const e of entries) {
		if (!Number.isSafeInteger(e.size) || e.size < 0) throw new RangeError("Invalid ZIP entry size.");
		const name = enc.encode(e.name).length;
		const time = e.modified === undefined ? 0 : EXTENDED_TIME_EXTRA;
		const zSize = e.size >= MAX32;
		const zOffset = offset >= MAX32;
		// Local header, name, ZIP64 extra (sizes), time extra, data, data descriptor (64-bit sizes when ZIP64).
		const local = LOCAL_HEADER + name + (zSize ? 20 : 0) + time + e.size + (zSize ? 24 : 16);
		// Central header, name, ZIP64 extra with only the fields that overflow, time extra.
		const z64 = zSize || zOffset ? 4 + (zSize ? 16 : 0) + (zOffset ? 8 : 0) : 0;
		central += CENTRAL_HEADER + name + z64 + time;
		offset += local;
	}
	const needZ64 = entries.length >= 0xffff || offset >= MAX32 || central >= MAX32;
	const total = offset + central + (needZ64 ? ZIP64_EOCD_AND_LOCATOR : 0) + EOCD;
	if (!Number.isSafeInteger(total)) throw new RangeError("ZIP archive too large.");
	return total;
}
