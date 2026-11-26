// Shared UI primitives. Every tool composes these, so the whole app keeps one look.
import { type ButtonHTMLAttributes, type ReactNode, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import s from "./ui.module.css";

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function Card({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cx(s.card, className)}>{children}</div>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost"; icon?: IconName };

export function Button({ variant = "primary", icon, className, children, ...rest }: ButtonProps) {
	return (
		<button type="button" className={cx(s.button, s[variant], className)} {...rest}>
			{icon && <Icon name={icon} size={16} />}
			{children}
		</button>
	);
}

export function Label({ children }: { children: ReactNode }) {
	return <span className={s.label}>{children}</span>;
}

export interface PillOption<T extends string> {
	value: T;
	label: string;
}

/** Segmented control: a radio group styled as pills. */
export function Pills<T extends string>({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string;
	value: T;
	options: PillOption<T>[];
	onChange: (value: T) => void;
	disabled?: boolean;
}) {
	const name = useId();
	return (
		<fieldset className={s.fieldset} disabled={disabled}>
			<legend className={s.legend}>
				<Label>{label}</Label>
			</legend>
			<div className={s.pills}>
				{options.map((o) => (
					<label key={o.value} className={s.pill}>
						<input
							type="radio"
							name={name}
							value={o.value}
							checked={o.value === value}
							onChange={() => onChange(o.value)}
						/>
						<span>{o.label}</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

export function Chip({ badge, name, meta, to }: { badge: string; name: string; meta?: string; to?: string }) {
	return (
		<div className={s.chip}>
			<span className={s.badge}>{badge}</span>
			<div className={s.chipText}>
				<span className={s.chipName} title={name}>
					{name}
				</span>
				{meta && <span className={s.chipMeta}>{meta}</span>}
			</div>
			{to && (
				<>
					<Icon name="arrow" size={16} className={s.arrow} />
					<span className={cx(s.badge, s.badgeOut)}>{to}</span>
				</>
			)}
		</div>
	);
}

export function Progress({
	value,
	max,
	label,
	detail,
}: {
	value: number;
	max: number;
	label: string;
	detail?: string;
}) {
	const known = max > 0;
	const pct = known ? Math.min(100, (value / max) * 100) : 0;
	return (
		<div className={s.progress}>
			<div
				className={s.track}
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={known ? max : undefined}
				aria-valuenow={known ? value : undefined}
			>
				<div className={cx(s.bar, !known && s.indeterminate)} style={{ width: `${pct}%` }} />
			</div>
			<div className={s.readout}>
				<span>{label}</span>
				<span>{detail}</span>
			</div>
		</div>
	);
}

export function Note({ tone, children }: { tone: "info" | "danger" | "success"; children: ReactNode }) {
	const icon: IconName = tone === "danger" ? "alert" : tone === "success" ? "check" : "info";
	return (
		<div className={cx(s.note, s[tone])} role={tone === "danger" ? "alert" : "status"}>
			<Icon name={icon} size={16} />
			<div>{children}</div>
		</div>
	);
}

/** Large drag-and-drop target that also opens the file picker on click. */
export function FileDrop({
	accept,
	title,
	hint,
	onFile,
}: {
	accept: string;
	title: string;
	hint: ReactNode;
	onFile: (file: File) => void;
}) {
	const [dragging, setDragging] = useState(false);
	const depth = useRef(0);
	return (
		<label
			className={cx(s.drop, dragging && s.dragging)}
			onDragEnter={(e) => {
				e.preventDefault();
				depth.current++;
				setDragging(true);
			}}
			onDragOver={(e) => e.preventDefault()}
			onDragLeave={() => {
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDragging(false);
			}}
			onDrop={(e) => {
				e.preventDefault();
				depth.current = 0;
				setDragging(false);
				const file = e.dataTransfer.files[0];
				if (file) onFile(file);
			}}
		>
			<input
				type="file"
				accept={accept}
				onChange={(e) => {
					const file = e.currentTarget.files?.[0];
					e.currentTarget.value = "";
					if (file) onFile(file);
				}}
			/>
			<span className={s.dropIcon}>
				<Icon name="upload" size={24} />
			</span>
			<span className={s.dropTitle}>{dragging ? "Release to convert" : title}</span>
			<span className={s.dropHint}>{hint}</span>
		</label>
	);
}

export function Kbd({ children }: { children: ReactNode }) {
	return <span className={s.kbd}>{children}</span>;
}
