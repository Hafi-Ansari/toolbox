// AcroForm field model shared by the worker and the UI. Values are strings:
// text and choice fields hold their text or export value, check boxes and radio groups
// hold the "on" appearance state name or "Off".
import type { Rect } from "./geometry.ts";

export type FieldKind = "text" | "checkbox" | "radio" | "combo" | "list" | "signature";

export interface FieldWidget {
	/** Page index in the first opened PDF. */
	page: number;
	/** Display coordinates on that page (same space as placed items). */
	rect: Rect;
	/** Check box / radio button: the appearance state this widget turns on. */
	state?: string;
}

export interface FieldOption {
	value: string;
	label: string;
}

export interface FormField {
	name: string;
	label: string;
	kind: FieldKind;
	widgets: FieldWidget[];
	options: FieldOption[];
	value: string;
	readOnly: boolean;
	required: boolean;
	multiline: boolean;
	maxLen: number;
	/** A combo box that also accepts typed text. */
	editable: boolean;
	/** A list box that allows several selections; only one can be set here. */
	multiSelect: boolean;
	/** A signature field that already holds a digital signature. */
	signed: boolean;
	/** Radio groups whose buttons cannot all be turned off. */
	noToggleOff: boolean;
}

export type XfaKind = "none" | "hybrid" | "only";

export interface FormInfo {
	fields: FormField[];
	xfa: XfaKind;
}

export type FormValues = Record<string, string>;

export const OFF = "Off";

export function initialValues(fields: FormField[]): FormValues {
	return Object.fromEntries(fields.map((field) => [field.name, field.value]));
}

/** Normalizes typed text for a text field: single-line fields drop line breaks, MaxLen is enforced. */
export function limitText(field: Pick<FormField, "multiline" | "maxLen">, text: string): string {
	let value = field.multiline ? text.replace(/\r\n?/g, "\n") : text.replace(/[\r\n]+/g, " ");
	if (field.maxLen > 0) value = [...value].slice(0, field.maxLen).join("");
	return value;
}

export function isOn(value: string | undefined): boolean {
	return Boolean(value) && value !== OFF;
}

/** The check box's "on" state name. */
export function onState(field: FormField): string {
	return field.widgets.find((widget) => widget.state)?.state ?? "Yes";
}

/** Changed, writable fields, as name → new value, in field order. */
export function formChanges(fields: FormField[], values: FormValues): FormValues {
	const changes: FormValues = {};
	for (const field of fields) {
		if (field.readOnly || field.kind === "signature") continue;
		const value = values[field.name] ?? field.value;
		const before =
			field.kind === "checkbox" || field.kind === "radio" ? (isOn(field.value) ? field.value : OFF) : field.value;
		const after = field.kind === "checkbox" || field.kind === "radio" ? (isOn(value) ? value : OFF) : value;
		if (after !== before) changes[field.name] = after;
	}
	return changes;
}

/** Required fields that are still empty. `signedFields` holds signature fields that have a placed signature. */
export function missingRequired(
	fields: FormField[],
	values: FormValues,
	signedFields: ReadonlySet<string>,
): FormField[] {
	return fields.filter((field) => {
		if (!field.required || field.readOnly) return false;
		if (field.kind === "signature") return !field.signed && !signedFields.has(field.name);
		const value = values[field.name] ?? field.value;
		if (field.kind === "checkbox" || field.kind === "radio") return !isOn(value);
		return !value.trim();
	});
}

export function describeField(field: FormField): string {
	switch (field.kind) {
		case "text":
			return field.multiline ? "Text, several lines" : "Text";
		case "checkbox":
			return "Check box";
		case "radio":
			return "Choose one";
		case "combo":
			return "Drop-down list";
		case "list":
			return "List";
		case "signature":
			return "Signature";
	}
}

/** Label for a radio state or choice value, as shown to the user. */
export function optionLabel(field: FormField, value: string): string {
	return field.options.find((option) => option.value === value)?.label ?? value;
}
