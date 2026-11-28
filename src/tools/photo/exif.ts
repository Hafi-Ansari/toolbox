// A minimal EXIF (TIFF) reader and in-place editor, for both byte orders. It reads the date taken
// and the orientation, and makes three edits without changing the block's length:
//   - Orientation → 1 (the pixels have been rotated already),
//   - the thumbnail (IFD1) is removed and its bytes zeroed (it would still show the old orientation),
//   - the GPS IFD is removed: its entry leaves IFD0 and every byte it pointed at is zeroed, so no
//     coordinates remain anywhere in the file.

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_OFFSET_ORIGINAL = 0x9011;
const TAG_THUMB_OFFSET = 0x0201;
const TAG_THUMB_LENGTH = 0x0202;

/** Bytes per value of each TIFF type (1 BYTE … 13 IFD). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

interface Entry {
	/** Offset of the 12-byte entry. */
	at: number;
	tag: number;
	type: number;
	count: number;
	/** Offset of the value: inside the entry when it fits in 4 bytes, else where the entry points. */
	value: number;
	size: number;
}

class Tiff {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	readonly le: boolean;

	constructor(bytes: Uint8Array) {
		if (bytes.length < 8) throw new Error("EXIF too short");
		const order = String.fromCharCode(bytes[0], bytes[1]);
		if (order !== "II" && order !== "MM") throw new Error("Not a TIFF header");
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.le = order === "II";
		if (this.u16(2) !== 42) throw new Error("Not a TIFF header");
	}

	inside(offset: number, length = 1) {
		return offset >= 8 && offset + length <= this.bytes.length;
	}
	u16(o: number) {
		return this.view.getUint16(o, this.le);
	}
	u32(o: number) {
		return this.view.getUint32(o, this.le);
	}
	setU16(o: number, v: number) {
		this.view.setUint16(o, v, this.le);
	}
	setU32(o: number, v: number) {
		this.view.setUint32(o, v, this.le);
	}
	zero(from: number, length: number) {
		const end = Math.min(this.bytes.length, from + length);
		if (from >= 8 && end > from) this.bytes.fill(0, from, end);
	}

	get ifd0() {
		return this.u32(4);
	}

	/** The entries of the IFD at `offset`, or [] when it's out of bounds. */
	entries(offset: number): Entry[] {
		if (!this.inside(offset, 2)) return [];
		const n = this.u16(offset);
		if (!this.inside(offset + 2, n * 12 + 4)) return [];
		const out: Entry[] = [];
		for (let i = 0; i < n; i++) {
			const at = offset + 2 + i * 12;
			const type = this.u16(at + 2);
			const count = this.u32(at + 4);
			const size = (TYPE_SIZE[type] ?? 1) * count;
			out.push({ at, tag: this.u16(at), type, count, value: size <= 4 ? at + 8 : this.u32(at + 8), size });
		}
		return out;
	}

	/** Offset of the 4-byte "next IFD" field of the IFD at `offset`. */
	nextField(offset: number) {
		return offset + 2 + this.u16(offset) * 12;
	}

	find(offset: number, tag: number) {
		return this.entries(offset).find((e) => e.tag === tag);
	}

	ascii(e: Entry) {
		if (!this.inside(e.value, e.size) && e.size > 4) return "";
		let s = "";
		for (let i = 0; i < e.count; i++) {
			const c = this.bytes[e.value + i];
			if (!c) break;
			s += String.fromCharCode(c);
		}
		return s;
	}
}

export interface ExifInfo {
	orientation: number;
	/** "YYYY:MM:DD HH:MM:SS" as written by the camera (local time), when present. */
	dateTaken: string | null;
	/** "+02:00" style offset for the date taken, when present. */
	offset: string | null;
	hasGps: boolean;
}

/** Reads what the converter needs; never throws (a broken block reads as empty). */
export function readExif(tiff: Uint8Array): ExifInfo {
	const info: ExifInfo = { orientation: 1, dateTaken: null, offset: null, hasGps: false };
	try {
		const t = new Tiff(tiff);
		const orientation = t.find(t.ifd0, TAG_ORIENTATION);
		if (orientation && orientation.type === 3) info.orientation = t.u16(orientation.value);
		info.hasGps = !!t.find(t.ifd0, TAG_GPS_IFD);
		const exifIfd = t.find(t.ifd0, TAG_EXIF_IFD);
		if (exifIfd) {
			const sub = t.u32(exifIfd.value);
			const date = t.find(sub, TAG_DATE_ORIGINAL);
			if (date && date.type === 2) info.dateTaken = t.ascii(date) || null;
			const offset = t.find(sub, TAG_OFFSET_ORIGINAL);
			if (offset && offset.type === 2) info.offset = t.ascii(offset) || null;
		}
	} catch {
		// Unreadable EXIF: report defaults.
	}
	if (info.orientation < 1 || info.orientation > 8) info.orientation = 1;
	return info;
}

export interface ExifEdits {
	stripGps: boolean;
}

/**
 * Returns an edited copy: Orientation 1, no thumbnail, and no GPS when asked. Returns null when the
 * block can't be parsed (the caller then leaves EXIF out rather than copy something unverified).
 */
export function editExif(tiff: Uint8Array, edits: ExifEdits): Uint8Array | null {
	let t: Tiff;
	try {
		t = new Tiff(tiff.slice());
	} catch {
		return null;
	}
	const ifd0 = t.ifd0;
	if (!t.inside(ifd0, 2)) return null;

	const orientation = t.find(ifd0, TAG_ORIENTATION);
	if (orientation && orientation.type === 3 && orientation.count === 1) t.setU16(orientation.value, 1);

	// Thumbnail: IFD1 is the IFD0 "next" link. Zero the IFD, its values and the JPEG it points at.
	const next = t.nextField(ifd0);
	if (t.inside(next, 4)) {
		const ifd1 = t.u32(next);
		if (ifd1 && t.inside(ifd1, 2)) {
			const entries = t.entries(ifd1);
			const offset = entries.find((e) => e.tag === TAG_THUMB_OFFSET);
			const length = entries.find((e) => e.tag === TAG_THUMB_LENGTH);
			if (offset && length) t.zero(t.u32(offset.value), t.u32(length.value));
			for (const e of entries) if (e.size > 4) t.zero(e.value, e.size);
			t.zero(ifd1, 2 + entries.length * 12 + 4);
		}
		t.setU32(next, 0);
	}

	if (edits.stripGps) {
		const gps = t.find(ifd0, TAG_GPS_IFD);
		if (gps) {
			const gpsIfd = t.u32(gps.value);
			const entries = t.entries(gpsIfd);
			for (const e of entries) if (e.size > 4) t.zero(e.value, e.size);
			if (entries.length) t.zero(gpsIfd, 2 + entries.length * 12 + 4);
			removeEntry(t, ifd0, gps.at);
		}
	}
	return t.bytes;
}

/** Removes one entry from an IFD: later entries move up, the count drops, the next link moves. */
function removeEntry(t: Tiff, ifd: number, at: number) {
	const count = t.u16(ifd);
	const end = ifd + 2 + count * 12;
	const nextLink = t.u32(end);
	t.bytes.copyWithin(at, at + 12, end);
	t.setU16(ifd, count - 1);
	const newEnd = end - 12;
	t.setU32(newEnd, nextLink);
	t.zero(newEnd + 4, 12);
}

/** "2026:11:28 02:42:10" (+ optional "+02:00") → a Date in the photo's local time, or null. */
export function takenDate(info: ExifInfo): Date | null {
	const m = info.dateTaken?.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
	if (!m) return null;
	const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
	if (y < 1980 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	// Zip entries store local wall-clock time, which is what the camera wrote: keep it as local.
	return new Date(y, mo - 1, d, h, mi, s);
}
