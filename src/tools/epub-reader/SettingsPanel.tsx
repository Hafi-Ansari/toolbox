import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { RIcon } from "./icons.tsx";
import s from "./Reader.module.css";
import {
	type Align,
	contrast,
	DEFAULT_SETTINGS,
	FONTS,
	type FontChoice,
	LINE_MAX,
	LINE_MIN,
	type ReaderSettings,
	SIZE_MAX,
	SIZE_MIN,
	TEXT_COLORS,
	THEMES,
	type Theme,
	WEIGHT_MAX,
	type Width,
} from "./settings.ts";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** A row of radio buttons styled as a segmented control. */
function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: ReactNode; title?: string }[];
	onChange: (v: T) => void;
}) {
	const name = useId();
	return (
		<fieldset className={s.field}>
			<legend className={s.fieldLabel}>{label}</legend>
			<div className={s.segmented} style={{ "--n": options.length } as CSSProperties}>
				{options.map((o) => (
					<label key={o.value} className={s.segment} title={o.title}>
						<input
							type="radio"
							name={name}
							value={o.value}
							checked={o.value === value}
							onChange={() => onChange(o.value)}
							aria-label={o.title}
						/>
						<span>{o.label}</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

function Toggle({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label className={s.toggleRow}>
			<span className={s.toggleText}>
				<span>{label}</span>
				{hint && <span className={s.toggleHint}>{hint}</span>}
			</span>
			<input
				type="checkbox"
				role="switch"
				aria-checked={checked}
				className={s.switch}
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
			/>
		</label>
	);
}

export function SettingsPanel({
	settings,
	update,
	fixed,
	rtl,
	onClose,
}: {
	settings: ReaderSettings;
	update: (patch: Partial<ReaderSettings>) => void;
	fixed: boolean;
	rtl: boolean;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<"style" | "layout">("style");
	const theme = THEMES[settings.theme];
	const colorId = useId();
	const ownColors = settings.colors === "original";
	const shownText = settings.textColor ?? theme.text;
	const lowContrast = !ownColors && contrast(shownText, theme.bg) < 3;
	const isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS);

	const themes = (
		<fieldset className={s.field}>
			<legend className={s.fieldLabel}>Theme</legend>
			<div className={s.themes}>
				{(Object.keys(THEMES) as Theme[]).map((id) => {
					const t = THEMES[id];
					return (
						<label key={id} className={s.themeOpt}>
							<input
								type="radio"
								name="reader-theme"
								value={id}
								checked={settings.theme === id}
								onChange={() => update({ theme: id })}
							/>
							<span
								className={s.themeSwatch}
								style={{ background: t.bg, color: t.text, borderColor: t.border }}
								aria-hidden="true"
							>
								Aa
							</span>
							<span className={s.themeName}>{t.label}</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);

	return (
		<div className={s.settings} role="dialog" aria-label="Reading settings" data-panel>
			<div className={s.grabber} aria-hidden="true" />
			<div className={s.panelHead}>
				{fixed ? (
					<span className={s.panelTitle}>Display</span>
				) : (
					<div className={s.tabs} role="tablist" aria-label="Settings sections">
						{(["style", "layout"] as const).map((id) => (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={tab === id}
								className={cx(s.tab, tab === id && s.tabOn)}
								onClick={() => setTab(id)}
							>
								{id === "style" ? "Style" : "Layout"}
							</button>
						))}
					</div>
				)}
				<button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close settings">
					<RIcon name="x" size={18} />
				</button>
			</div>

			<div className={s.settingsBody}>
				{fixed ? (
					<>
						{themes}
						{theme.dark && (
							<Toggle
								label="Dim images"
								hint="Softer pictures on dark pages"
								checked={settings.dimImages}
								onChange={(dimImages) => update({ dimImages })}
							/>
						)}
					</>
				) : tab === "style" ? (
					<>
						{themes}

						<div className={s.field}>
							<span className={s.fieldLabel} id={`${colorId}-size`}>
								Text size <span className={s.fieldValue}>{settings.size}px</span>
							</span>
							<div className={s.sliderRow}>
								<button
									type="button"
									className={s.stepBtn}
									onClick={() => update({ size: Math.max(SIZE_MIN, settings.size - 1) })}
									disabled={settings.size <= SIZE_MIN}
									aria-label="Smaller text"
								>
									<span style={{ fontSize: 13 }}>A</span>
								</button>
								<input
									type="range"
									className={s.slider}
									min={SIZE_MIN}
									max={SIZE_MAX}
									step={1}
									value={settings.size}
									onChange={(e) => update({ size: Number(e.target.value) })}
									aria-labelledby={`${colorId}-size`}
									style={{ "--p": (settings.size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN) } as CSSProperties}
								/>
								<button
									type="button"
									className={s.stepBtn}
									onClick={() => update({ size: Math.min(SIZE_MAX, settings.size + 1) })}
									disabled={settings.size >= SIZE_MAX}
									aria-label="Larger text"
								>
									<span style={{ fontSize: 20 }}>A</span>
								</button>
							</div>
						</div>

						<fieldset className={s.field}>
							<legend className={s.fieldLabel}>Font</legend>
							<div className={s.fonts}>
								{(Object.keys(FONTS) as FontChoice[]).map((id) => (
									<label key={id} className={s.fontOpt}>
										<input
											type="radio"
											name="reader-font"
											value={id}
											checked={settings.font === id}
											onChange={() => update({ font: id })}
										/>
										<span
											className={s.fontSample}
											style={{ fontFamily: FONTS[id].stack || "inherit" }}
											aria-hidden="true"
										>
											{id === "original" ? <RIcon name="book" size={20} /> : "Ag"}
										</span>
										<span className={s.fontName}>{FONTS[id].label}</span>
									</label>
								))}
							</div>
						</fieldset>

						<Segmented<string>
							label="Boldness"
							value={String(settings.weight)}
							options={Array.from({ length: WEIGHT_MAX + 1 }, (_, w) => ({
								value: String(w),
								title: ["Normal weight", "Slightly bolder", "Bolder", "Boldest"][w],
								label: (
									<span
										className={s.weightSample}
										style={{ WebkitTextStroke: `${(w * 0.022).toFixed(3)}em currentColor` } as CSSProperties}
									>
										Aa
									</span>
								),
							}))}
							onChange={(v) => update({ weight: Number(v) })}
						/>

						<fieldset className={s.field} disabled={ownColors}>
							<legend className={s.fieldLabel}>
								Text color
								{ownColors && <span className={s.fieldValue}>book colors on</span>}
							</legend>
							<div className={s.colors}>
								<label className={s.colorOpt} title="Theme default">
									<input
										type="radio"
										name="reader-color"
										checked={settings.textColor === null}
										onChange={() => update({ textColor: null })}
										aria-label="Theme default"
									/>
									<span className={s.colorAuto} style={{ background: theme.bg, color: theme.text }} aria-hidden="true">
										A
									</span>
								</label>
								{TEXT_COLORS.map((c) => (
									<label key={c.value} className={s.colorOpt} title={c.label}>
										<input
											type="radio"
											name="reader-color"
											checked={settings.textColor === c.value}
											onChange={() => update({ textColor: c.value })}
											aria-label={c.label}
										/>
										<span className={s.colorDot} style={{ background: c.value }} aria-hidden="true" />
									</label>
								))}
								<label
									className={cx(
										s.colorOpt,
										s.colorCustom,
										settings.textColor !== null &&
											!TEXT_COLORS.some((c) => c.value === settings.textColor) &&
											s.colorCustomOn,
									)}
									title="Pick any color"
								>
									<input
										type="color"
										value={shownText}
										onChange={(e) => update({ textColor: e.target.value })}
										aria-label="Custom text color"
									/>
									<span className={s.colorDot} aria-hidden="true" />
								</label>
							</div>
							{lowContrast && (
								<span className={s.warn} role="status">
									Low contrast on this theme. Try another color or theme.
								</span>
							)}
						</fieldset>
					</>
				) : (
					<>
						<div className={s.field}>
							<span className={s.fieldLabel} id={`${colorId}-lh`}>
								Line spacing <span className={s.fieldValue}>{settings.lineHeight.toFixed(1)}</span>
							</span>
							<div className={s.sliderRow}>
								<RIcon name="lines-tight" size={18} className={s.sliderIcon} />
								<input
									type="range"
									className={s.slider}
									min={LINE_MIN}
									max={LINE_MAX}
									step={0.1}
									value={settings.lineHeight}
									onChange={(e) => update({ lineHeight: Number(e.target.value) })}
									aria-labelledby={`${colorId}-lh`}
									style={{ "--p": (settings.lineHeight - LINE_MIN) / (LINE_MAX - LINE_MIN) } as CSSProperties}
								/>
								<RIcon name="lines-loose" size={18} className={s.sliderIcon} />
							</div>
						</div>

						<Segmented<string>
							label="Paragraph spacing"
							value={settings.paragraph == null ? "book" : String(settings.paragraph)}
							options={[
								{ value: "book", label: "Book" },
								{ value: "0", label: "None" },
								{ value: "0.6", label: "Some" },
								{ value: "1.2", label: "More" },
							]}
							onChange={(v) => update({ paragraph: v === "book" ? null : Number(v) })}
						/>

						<Segmented<Align>
							label="Alignment"
							value={settings.align}
							options={[
								{ value: "original", label: "Auto", title: "As the book sets it (ragged on narrow screens)" },
								{ value: "left", label: <RIcon name="align-left" size={18} />, title: "Align left" },
								{ value: "justify", label: <RIcon name="align-justify" size={18} />, title: "Justify" },
							]}
							onChange={(align) => update({ align })}
						/>

						<Segmented<Width>
							label="Line width"
							value={settings.width}
							options={[
								{ value: "narrow", label: "Narrow" },
								{ value: "medium", label: "Medium" },
								{ value: "wide", label: "Wide" },
							]}
							onChange={(width) => update({ width })}
						/>

						{!rtl && (
							<Segmented<ReaderSettings["mode"]>
								label="Layout"
								value={settings.mode}
								options={[
									{ value: "paged", label: "Pages", title: "Pages" },
									{ value: "scroll", label: "Scroll", title: "Scroll" },
								]}
								onChange={(mode) => update({ mode })}
							/>
						)}

						<div className={s.toggles}>
							<Toggle
								label="Book's own colors"
								hint="Keep the publisher's text and background colors"
								checked={ownColors}
								onChange={(on) => update({ colors: on ? "original" : "override" })}
							/>
							{theme.dark && (
								<Toggle
									label="Dim images"
									hint="Softer pictures on dark pages"
									checked={settings.dimImages}
									onChange={(dimImages) => update({ dimImages })}
								/>
							)}
						</div>

						<button
							type="button"
							className={s.reset}
							disabled={isDefault}
							onClick={() => update({ ...DEFAULT_SETTINGS })}
						>
							Reset to defaults
						</button>
					</>
				)}
			</div>
		</div>
	);
}
