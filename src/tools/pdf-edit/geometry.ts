export type Point = [number, number];
export type Rect = [number, number, number, number];
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Applies the first transform, then the second. */
export function concat([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix {
	return [a * g + b * i, a * h + b * j, c * g + d * i, c * h + d * j, e * g + f * i + k, e * h + f * j + l];
}

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
	const det = a * d - b * c;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply([x, y]: Point, [a, b, c, d, e, f]: Matrix): Point {
	return [x * a + y * c + e, x * b + y * d + f];
}

export function applyRect([x0, y0, x1, y1]: Rect, matrix: Matrix): Rect {
	const corners = [apply([x0, y0], matrix), apply([x1, y0], matrix), apply([x0, y1], matrix), apply([x1, y1], matrix)];
	const xs = corners.map(([x]) => x);
	const ys = corners.map(([, y]) => y);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** PDF's rotated CropBox, in display points with origin at its top-left. */
export function pageTransform(media: Rect, crop: Rect | undefined, rotate: number, userUnit = 1): Matrix {
	const intersection: Rect = crop
		? [
				Math.max(media[0], crop[0]),
				Math.max(media[1], crop[1]),
				Math.min(media[2], crop[2]),
				Math.min(media[3], crop[3]),
			]
		: media;
	const visible = intersection[2] > intersection[0] && intersection[3] > intersection[1] ? intersection : media;
	const quarter = ((Math.round(rotate / 90) % 4) + 4) % 4;
	const turns: Matrix[] = [IDENTITY, [0, -1, 1, 0, 0, 0], [-1, 0, 0, -1, 0, 0], [0, 1, -1, 0, 0, 0]];
	const matrix = concat(turns[quarter], [userUnit, 0, 0, -userUnit, 0, 0]);
	const [left, top] = applyRect(visible, matrix);
	return [...matrix.slice(0, 4), -left, -top] as Matrix;
}

interface View {
	left: number;
	top: number;
	scale: number;
}

export function screenToPage([x, y]: Point, { left, top, scale }: View): Point {
	return [(x - left) / scale, (y - top) / scale];
}

export function pageToScreen([x, y]: Point, { left, top, scale }: View): Point {
	return [left + x * scale, top + y * scale];
}

/** Item-local PDF coordinates (y up) to the target page's PDF user space. */
export function itemMatrix({ x, y, h }: { x: number; y: number; h: number }, page: Matrix): Matrix {
	return concat([1, 0, 0, -1, x, y + h], invert(page));
}
