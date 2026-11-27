export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,image/png,image/jpeg";

export interface Asset {
	data: Uint8Array<ArrayBuffer>;
	src: string;
	w: number;
	h: number;
}

export async function decodeImage(file: Blob, transparent = false): Promise<Asset> {
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("The image editor could not start.");
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		if (transparent) {
			const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
			for (let i = 0; i < pixels.data.length; i += 4) {
				if (Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) >= 245) pixels.data[i + 3] = 0;
			}
			ctx.putImageData(pixels, 0, 0);
		}
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be saved."))), "image/png"),
		);
		return {
			data: new Uint8Array(await blob.arrayBuffer()),
			src: canvas.toDataURL("image/png"),
			w: canvas.width,
			h: canvas.height,
		};
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function readImage(file: File, transparent?: boolean): Promise<Asset> {
	const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
	const png = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
	const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
	if (!png && !jpeg) throw new Error("Choose a PNG or JPEG image.");
	return decodeImage(file, transparent);
}
