import * as mupdf from "mupdf";
import { type FieldKind, type FormField, type FormInfo, type FormValues, isOn, OFF } from "./forms.ts";
import type { Rect } from "./geometry.ts";

const KINDS: Record<string, FieldKind> = {
	text: "text",
	checkbox: "checkbox",
	radiobutton: "radio",
	combobox: "combo",
	listbox: "list",
	signature: "signature",
};

function onStates(widget: mupdf.PDFWidget): string[] {
	const states: string[] = [];
	const normal = widget.getObject().get("AP", "N");
	if (normal.isDictionary())
		normal.forEach((_, key) => {
			if (typeof key === "string" && key !== OFF) states.push(key);
		});
	return states;
}

function fieldFor(widget: mupdf.PDFWidget, kind: FieldKind, name: string): FormField {
	const flags = widget.getFieldFlags();
	const field: FormField = {
		name,
		label: widget.getLabel().trim() || name,
		kind,
		widgets: [],
		options: [],
		value: widget.getValue(),
		readOnly: widget.isReadOnly(),
		required: Boolean(flags & mupdf.PDFWidget.FIELD_IS_REQUIRED),
		multiline: kind === "text" && widget.isMultiline(),
		maxLen: kind === "text" ? widget.getMaxLen() : 0,
		editable: kind === "combo" && Boolean(flags & mupdf.PDFWidget.CH_FIELD_IS_EDIT),
		multiSelect: kind === "list" && Boolean(flags & mupdf.PDFWidget.CH_FIELD_IS_MULTI_SELECT),
		signed: kind === "signature" && !widget.getObject().getInheritable("V").isNull(),
		noToggleOff: kind === "radio" && Boolean(flags & mupdf.PDFWidget.BTN_FIELD_IS_NO_TOGGLE_TO_OFF),
	};
	if (kind === "combo" || kind === "list") {
		const labels = widget.getOptions(false);
		const values = widget.getOptions(true);
		field.options = labels.map((label, i) => ({ value: values[i] ?? label, label }));
	}
	return field;
}

function hasFields(form: mupdf.PDFObject): boolean {
	const fields = form.get("Fields");
	return fields.isArray() && fields.length > 0;
}

/** Lists the AcroForm fields a user can fill, in page order. Push buttons and unnamed widgets are skipped. */
export function readForm(doc: mupdf.PDFDocument): FormInfo {
	const form = doc.getTrailer().get("Root", "AcroForm");
	if (!form.isDictionary()) return { fields: [], xfa: "none" };
	const xfa = !form.get("XFA").isNull();
	const fields = new Map<string, FormField>();
	if (hasFields(form)) {
		const count = doc.countPages();
		for (let index = 0; index < count; index++) {
			const page = doc.loadPage(index);
			try {
				for (const widget of page.getWidgets()) {
					const kind = KINDS[widget.getFieldType()];
					const name = widget.getName();
					if (!kind || !name) continue;
					let field = fields.get(name);
					if (!field) {
						field = fieldFor(widget, kind, name);
						fields.set(name, field);
					}
					if (field.kind !== kind) continue;
					const states = kind === "checkbox" || kind === "radio" ? onStates(widget) : [];
					const state = states[0] ?? (kind === "checkbox" || kind === "radio" ? "Yes" : undefined);
					field.widgets.push({ page: index, rect: widget.getRect() as Rect, state });
					if (kind === "radio" && state && !field.options.some((option) => option.value === state))
						field.options.push({ value: state, label: state });
				}
			} finally {
				page.destroy();
			}
		}
	}
	const list = [...fields.values()];
	return { fields: list, xfa: xfa ? (list.length ? "hybrid" : "only") : "none" };
}

/**
 * Writes changed values through MuPDF's widget API, which regenerates each field's appearance.
 * With `flatten`, the form is baked into page content and the fields are removed.
 */
export function fillForm(doc: mupdf.PDFDocument, changes: FormValues, flatten: boolean): void {
	const form = doc.getTrailer().get("Root", "AcroForm");
	if (!form.isDictionary()) return;
	const names = new Set(Object.keys(changes));
	const toggled = new Set<string>();
	const count = doc.countPages();
	for (let index = 0; index < count && (names.size || flatten); index++) {
		const page = doc.loadPage(index);
		try {
			let touched = false;
			for (const widget of page.getWidgets()) {
				const name = widget.getName();
				const kind = KINDS[widget.getFieldType()];
				if (flatten && kind === "signature" && widget.getObject().getInheritable("V").isNull()) {
					// An unsigned field would bake MuPDF's placeholder into the page.
					page.deleteAnnotation(widget);
					touched = true;
					continue;
				}
				if (!names.has(name) || widget.isReadOnly()) continue;
				const value = changes[name];
				if (kind === "text") widget.setTextValue(value);
				else if (kind === "combo" || kind === "list") widget.setChoiceValue(value);
				else if (kind === "checkbox") {
					if (toggled.has(name)) continue;
					toggled.add(name);
					if (isOn(widget.getValue()) !== isOn(value)) widget.toggle();
				} else if (kind === "radio") {
					const state = onStates(widget)[0];
					const current = widget.getValue();
					if (value === OFF ? state === current : state === value && current !== value) widget.toggle();
				} else continue;
				touched = true;
			}
			if (touched) page.update();
		} finally {
			page.destroy();
		}
	}
	// Viewers that understand XFA would show the old XFA data instead of the values set here.
	if (names.size) form.delete("XFA");
	if (flatten) doc.bake(false, true);
}
