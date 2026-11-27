import { expect, it } from "vitest";
import {
	type FormField,
	formChanges,
	initialValues,
	limitText,
	missingRequired,
	onState,
	optionLabel,
} from "./forms.ts";

const base: FormField = {
	name: "",
	label: "",
	kind: "text",
	widgets: [{ page: 0, rect: [0, 0, 10, 10] }],
	options: [],
	value: "",
	readOnly: false,
	required: false,
	multiline: false,
	maxLen: 0,
	editable: false,
	multiSelect: false,
	signed: false,
	noToggleOff: false,
};
const fields: FormField[] = [
	{ ...base, name: "name", required: true },
	{ ...base, name: "notes", multiline: true, maxLen: 5 },
	{
		...base,
		name: "agree",
		kind: "checkbox",
		value: "Off",
		required: true,
		widgets: [{ ...base.widgets[0], state: "Oui" }],
	},
	{
		...base,
		name: "size",
		kind: "radio",
		value: "Off",
		options: [
			{ value: "s", label: "Small" },
			{ value: "l", label: "Large" },
		],
	},
	{ ...base, name: "fruit", kind: "list", options: [{ value: "p", label: "Pear" }] },
	{ ...base, name: "ref", value: "FIXED", readOnly: true, required: true },
	{ ...base, name: "sig", kind: "signature", required: true },
];

it("limits text to one line or MaxLen, counting characters rather than UTF-16 units", () => {
	expect(limitText(fields[0], "Ada\r\nLovelace\n")).toBe("Ada Lovelace ");
	expect(limitText(fields[1], "ab\r\ncdefg")).toBe("ab\ncd");
	expect(limitText({ multiline: false, maxLen: 2 }, "🍐🍎🍊")).toBe("🍐🍎");
});

it("reports only changed, writable values and normalizes empty on/off states", () => {
	const values = { ...initialValues(fields), name: "Ada", agree: "Oui", ref: "changed", sig: "x" };
	expect(formChanges(fields, values)).toEqual({ name: "Ada", agree: "Oui" });
	expect(formChanges(fields, { ...initialValues(fields), size: "" })).toEqual({});
	expect(formChanges(fields, { ...initialValues(fields), size: "l", fruit: "p" })).toEqual({ size: "l", fruit: "p" });
	expect(onState(fields[2])).toBe("Oui");
	expect(optionLabel(fields[3], "l")).toBe("Large");
	expect(optionLabel(fields[3], "other")).toBe("other");
});

it("lists required fields that are empty, skipping read-only ones and counting placed signatures", () => {
	const values = initialValues(fields);
	expect(missingRequired(fields, values, new Set()).map(({ name }) => name)).toEqual(["name", "agree", "sig"]);
	expect(
		missingRequired(fields, { ...values, name: "  ", agree: "Oui" }, new Set(["sig"])).map(({ name }) => name),
	).toEqual(["name"]);
});
