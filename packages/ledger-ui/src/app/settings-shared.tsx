import type { ComponentChildren, JSX } from "preact";
import { useId, useState } from "preact/hooks";
import type { SchoolSettings as SettingsData } from "../data/settings.ts";
import type { School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { Dialog } from "./dialog.tsx";
import { Icon, type IconName } from "./icon.tsx";

export const saveFailed = "Could not save. Try again.";

export type Section = {
	school: School;
	writer: Writer;
	settings: SettingsData;
	update: (change: (current: SettingsData) => SettingsData) => void;
	/** Owners change settings; an admin reads them; while previewing, nothing is written. */
	writeOff: { disabled: boolean; title: string | undefined };
	money: (minorUnits: number) => string;
	onToast: (text: string) => void;
	onModal: (modal: ComponentChildren) => void;
};

/** A dialog over the drawer (mockup `#md`): a title, a body, Cancel and the confirming action. Escape, a click on the
 * backdrop and Cancel close it; Tab stays inside; focus starts on the first field, else on the first button. The
 * action stays busy until it answers, and says so if it fails. */
export function SettingsDialog({
	title,
	icon,
	children,
	confirm,
	extra,
	onCancel,
	cancelable = true,
}: {
	title: string;
	icon?: IconName;
	children: ComponentChildren;
	confirm: {
		label: string;
		icon?: IconName;
		danger?: boolean;
		disabled?: boolean;
		onConfirm: () => Promise<void> | void;
	};
	extra?: ComponentChildren;
	onCancel: () => void;
	/** False for a dialog with only its closing button. */
	cancelable?: boolean;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const run = async (): Promise<void> => {
		setBusy(true);
		setFailed(false);
		try {
			await confirm.onConfirm();
		} catch {
			setFailed(true);
		}
		setBusy(false);
	};
	return (
		<Dialog
			title={
				<>
					{icon && <Icon name={icon} />} {title}
				</>
			}
			onClose={onCancel}
		>
			{children}
			{failed && (
				<div class="err" role="alert">
					{saveFailed}
				</div>
			)}
			<div class="mf">
				{extra}
				{cancelable && (
					<button
						type="button"
						class="btn"
						data-test="dialog-cancel"
						onClick={onCancel}
					>
						Cancel
					</button>
				)}
				<button
					type="button"
					class={confirm.danger ? "btn d" : "btn p"}
					data-test="dialog-confirm"
					disabled={busy || confirm.disabled}
					aria-busy={busy || undefined}
					onClick={run}
				>
					{confirm.icon && <Icon name={confirm.icon} />}
					{confirm.label}
				</button>
			</div>
		</Dialog>
	);
}

/** A labelled field of a dialog (hook `dialog-field`, by `data-field`). */
export function Field({
	label,
	field,
	value,
	onInput,
	placeholder,
	secret = true,
	numeric = false,
}: {
	label: string;
	field: "label" | "key" | "pin" | "apiKey";
	value: string;
	onInput: (value: string) => void;
	placeholder?: string;
	secret?: boolean;
	numeric?: boolean;
}): JSX.Element {
	const id = useId();
	return (
		<div class="fld">
			<label for={id}>{label}</label>
			<input
				id={id}
				type={secret ? "password" : "text"}
				inputMode={numeric ? "numeric" : undefined}
				maxLength={numeric ? 6 : undefined}
				autoComplete="off"
				placeholder={placeholder}
				data-test="dialog-field"
				data-field={field}
				value={value}
				onInput={(event) => onInput(event.currentTarget.value)}
			/>
		</div>
	);
}
