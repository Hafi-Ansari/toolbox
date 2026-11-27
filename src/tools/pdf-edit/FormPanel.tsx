import { Note } from "../../lib/ui.tsx";
import {
	describeField,
	type FormField,
	type FormInfo,
	type FormValues,
	isOn,
	limitText,
	OFF,
	onState,
	optionLabel,
} from "./forms.ts";
import type { PageSize } from "./items.ts";
import s from "./PdfEdit.module.css";

export const fieldId = (index: number) => `pdf-field-${index}`;

function focusField(index: number) {
	const element = document.getElementById(fieldId(index));
	element?.scrollIntoView({ block: "nearest" });
	element?.focus({ preventScroll: true });
}

/** Highlights the fields of one page, showing their current values. Clicking one focuses it in the list. */
export function FieldOverlay({
	fields,
	page,
	size,
	values,
	missing,
	active,
}: {
	fields: FormField[];
	/** Index of the page in the first PDF. */
	page: number;
	size: PageSize;
	values: FormValues;
	missing: ReadonlySet<string>;
	active?: string;
}) {
	return (
		<>
			{fields.flatMap((field, index) =>
				field.widgets.flatMap((widget, w) => {
					if (widget.page !== page) return [];
					const [x0, y0, x1, y1] = widget.rect;
					const value = values[field.name] ?? field.value;
					let shown = "";
					if (field.kind === "checkbox") shown = isOn(value) ? "✓" : "";
					else if (field.kind === "radio") shown = value === widget.state ? "●" : "";
					else if (field.kind === "combo" || field.kind === "list") shown = value ? optionLabel(field, value) : "";
					else if (field.kind === "text") shown = value;
					return [
						<button
							type="button"
							// biome-ignore lint/suspicious/noArrayIndexKey: Widgets have no other identity.
							key={`${field.name}:${w}`}
							className={s.fieldBox}
							data-kind={field.kind}
							data-missing={missing.has(field.name) || undefined}
							data-active={active === field.name || undefined}
							data-readonly={field.readOnly || undefined}
							tabIndex={-1}
							aria-label={`${field.label} field on the page`}
							style={{
								left: `${(x0 / size.w) * 100}%`,
								top: `${(y0 / size.h) * 100}%`,
								width: `${((x1 - x0) / size.w) * 100}%`,
								height: `${((y1 - y0) / size.h) * 100}%`,
								fontSize: `${(Math.min(11, (y1 - y0) * 0.7) / size.h) * 100}cqh`,
							}}
							onPointerDown={(e) => e.stopPropagation()}
							onClick={() => focusField(index)}
						>
							{field.kind !== "signature" && <span>{shown}</span>}
						</button>,
					];
				}),
			)}
		</>
	);
}

function FieldInput({
	field,
	index,
	value,
	missing,
	setValue,
	focus,
	sign,
	signed,
	unsign,
}: {
	field: FormField;
	index: number;
	value: string;
	missing: boolean;
	setValue: (value: string) => void;
	focus: () => void;
	sign: () => void;
	signed: boolean;
	unsign: () => void;
}) {
	const id = fieldId(index);
	const common = {
		id,
		onFocus: focus,
		disabled: field.readOnly,
		"aria-invalid": missing || undefined,
		"aria-required": field.required || undefined,
	};
	const title = (
		<span className={s.fieldTitle}>
			{field.label}
			{field.required && <abbr title="required"> *</abbr>}
			<small>
				{describeField(field)}
				{field.readOnly ? ", read-only" : ""}
			</small>
		</span>
	);
	switch (field.kind) {
		case "text":
			return (
				<label className={s.field} htmlFor={id}>
					{title}
					{field.multiline ? (
						<textarea {...common} rows={3} value={value} onChange={(e) => setValue(limitText(field, e.target.value))} />
					) : (
						<input {...common} type="text" value={value} onChange={(e) => setValue(limitText(field, e.target.value))} />
					)}
					{field.maxLen > 0 && (
						<small className={s.fieldHint}>
							{[...value].length} / {field.maxLen} characters
						</small>
					)}
				</label>
			);
		case "checkbox":
			return (
				<label className={`${s.field} ${s.fieldCheck}`}>
					<input
						{...common}
						type="checkbox"
						checked={isOn(value)}
						onChange={(e) => setValue(e.target.checked ? onState(field) : OFF)}
					/>
					{title}
				</label>
			);
		case "radio":
			return (
				<fieldset className={s.field} aria-invalid={missing || undefined}>
					<legend>{title}</legend>
					<div className={s.fieldChoices}>
						{field.options.map((option, i) => (
							<label key={option.value} className={s.fieldCheck}>
								<input
									{...common}
									id={i === 0 ? id : undefined}
									type="radio"
									name={id}
									checked={value === option.value}
									onChange={() => setValue(option.value)}
								/>
								{option.label}
							</label>
						))}
						{!field.noToggleOff && isOn(value) && !field.readOnly && (
							<button type="button" className={s.linkButton} onClick={() => setValue(OFF)}>
								Clear choice
							</button>
						)}
					</div>
				</fieldset>
			);
		case "combo":
		case "list":
			if (field.editable)
				return (
					<label className={s.field}>
						{title}
						<input
							{...common}
							type="text"
							list={`${id}-options`}
							value={value}
							onChange={(e) => setValue(e.target.value)}
						/>
						<datalist id={`${id}-options`}>
							{field.options.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</datalist>
					</label>
				);
			return (
				<label className={s.field}>
					{title}
					<select {...common} value={value} onChange={(e) => setValue(e.target.value)}>
						<option value="">(none)</option>
						{!field.options.some((option) => option.value === value) && value && <option value={value}>{value}</option>}
						{field.options.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					{field.multiSelect && (
						<small className={s.fieldHint}>This list allows several choices; one can be set here.</small>
					)}
				</label>
			);
		case "signature":
			return (
				<div className={s.field}>
					{title}
					{field.signed ? (
						<small className={s.fieldHint}>Already digitally signed. It can't be changed here.</small>
					) : (
						<div className={s.fieldChoices}>
							<button
								type="button"
								id={id}
								onFocus={focus}
								className={s.fieldButton}
								aria-invalid={missing || undefined}
								onClick={sign}
							>
								{signed ? "Replace signature" : "Sign here"}
							</button>
							{signed && (
								<button type="button" className={s.linkButton} onClick={unsign}>
									Remove
								</button>
							)}
						</div>
					)}
				</div>
			);
	}
}

export function FormPanel({
	form,
	fields,
	values,
	missing,
	signedFields,
	setValue,
	focus,
	sign,
	unsign,
	pageNumber,
}: {
	form: FormInfo;
	/** Fields whose pages are still in the document. */
	fields: FormField[];
	values: FormValues;
	missing: ReadonlySet<string>;
	signedFields: ReadonlySet<string>;
	setValue: (name: string, value: string) => void;
	focus: (field: FormField) => void;
	sign: (field: FormField) => void;
	unsign: (field: FormField) => void;
	pageNumber: (field: FormField) => number | undefined;
}) {
	let lastPage: number | undefined;
	return (
		<section className={s.formPanel} aria-label="Form fields">
			<h2>Form fields</h2>
			{form.xfa === "hybrid" && (
				<Note tone="info">
					This form also carries XFA data. Values are saved to the standard form fields, and the XFA copy is removed so
					every viewer shows them.
				</Note>
			)}
			{!fields.length && <p className={s.fieldHint}>The pages with form fields have been removed.</p>}
			<div className={s.fieldList}>
				{fields.map((field) => {
					const index = form.fields.indexOf(field);
					const page = pageNumber(field);
					const heading = page !== lastPage ? page : undefined;
					lastPage = page;
					return (
						<div key={field.name} className={s.fieldRow}>
							{heading !== undefined && <h3>Page {heading}</h3>}
							<FieldInput
								field={field}
								index={index}
								value={values[field.name] ?? field.value}
								missing={missing.has(field.name)}
								setValue={(value) => setValue(field.name, value)}
								focus={() => focus(field)}
								sign={() => sign(field)}
								unsign={() => unsign(field)}
								signed={signedFields.has(field.name)}
							/>
						</div>
					);
				})}
			</div>
		</section>
	);
}
