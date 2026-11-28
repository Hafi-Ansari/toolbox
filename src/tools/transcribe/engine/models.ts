// The Whisper models on offer. Weights come from Hugging Face on first use (onnx-community
// conversions) and stay in the browser's Cache Storage; sizes are the files actually fetched.

export type ModelId = "turbo" | "small" | "base" | "tiny-en";
export type Device = "webgpu" | "wasm";

export interface ModelSpec {
	id: ModelId;
	label: string;
	repo: string;
	/** ONNX precision per device: encoder and merged decoder. */
	dtype: Record<Device, { encoder_model: string; decoder_model_merged: string }>;
	/** Approximate download per device, in MB. */
	sizeMB: Record<Device, number>;
	/** English-only models take no language option. */
	englishOnly: boolean;
	/** Can this device run it in reasonable time? */
	devices: Device[];
	note: string;
}

export const MODELS: ModelSpec[] = [
	{
		id: "turbo",
		label: "Turbo",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: {
			webgpu: { encoder_model: "fp16", decoder_model_merged: "q4" },
			wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
		},
		sizeMB: { webgpu: 1610, wasm: 1085 },
		englishOnly: false,
		devices: ["webgpu"],
		note: "Most accurate. Whisper large-v3-turbo, the model the desktop script uses.",
	},
	{
		id: "small",
		label: "Small",
		repo: "onnx-community/whisper-small",
		dtype: {
			webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
			wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
		},
		sizeMB: { webgpu: 586, wasm: 249 },
		englishOnly: false,
		devices: ["webgpu", "wasm"],
		note: "Good accuracy, much smaller.",
	},
	{
		id: "base",
		label: "Base",
		repo: "onnx-community/whisper-base",
		dtype: {
			webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
			wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
		},
		sizeMB: { webgpu: 206, wasm: 77 },
		englishOnly: false,
		devices: ["webgpu", "wasm"],
		note: "Fast, more mistakes.",
	},
	{
		id: "tiny-en",
		label: "Tiny (English)",
		repo: "onnx-community/whisper-tiny.en",
		dtype: {
			webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
			wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
		},
		sizeMB: { webgpu: 120, wasm: 41 },
		englishOnly: true,
		devices: ["webgpu", "wasm"],
		note: "Fastest, English only, roughest.",
	},
];

export const modelById = (id: ModelId): ModelSpec => MODELS.find((m) => m.id === id) ?? MODELS[0];

/** The script's own policy: large-v3-turbo on the GPU, small on the CPU. */
export const autoModel = (device: Device): ModelId => (device === "webgpu" ? "turbo" : "small");
