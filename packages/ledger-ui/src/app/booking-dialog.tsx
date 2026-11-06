import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { useFocusTrap } from "./focus-trap.ts";

type BookingDialogProps = {
	/** "Mark no-show · Vibes of Light". */
	title: string;
	/** The booking line: item, booking id, member and member key. */
	detail: string;
	confirmLabel: string;
	/** The label of the "Waive the late-cancel forfeit" box, for a release inside the cutoff; without it, no box. */
	waiveLabel?: string | undefined;
	onConfirm: (waiveCutoff: boolean) => void;
	onCancel: () => void;
};

/** The mockup's modal (`#md`, `openAct`) for No-show and for Release hold inside the cutoff: a title, the booking line,
 * the waive box where it applies, Cancel and the action. Escape, a click on the backdrop and Cancel close it; Tab stays
 * inside; focus starts on Cancel and returns to the button that opened it. */
export function BookingDialog({
	title,
	detail,
	confirmLabel,
	waiveLabel,
	onConfirm,
	onCancel,
}: BookingDialogProps): JSX.Element {
	const [waive, setWaive] = useState(false);
	const modal = useRef<HTMLDivElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	useFocusTrap(true, modal, onCancel);
	useEffect(() => {
		const opener = document.activeElement;
		cancelButton.current?.focus();
		return () => {
			if (opener instanceof HTMLElement) opener.focus();
		};
	}, []);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the dialog (useFocusTrap); a click on the backdrop is a pointer shortcut for the same
		<div
			class="bg on"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) onCancel();
			}}
		>
			<div
				ref={modal}
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-test="dialog"
			>
				<h3 id={titleId} data-test="dialog-title">
					{title}
				</h3>
				<div class="mut">{detail}</div>
				{waiveLabel && (
					<div class="fld c">
						<label>
							<input
								type="checkbox"
								data-test="waive-cutoff"
								checked={waive}
								onChange={(event) => setWaive(event.currentTarget.checked)}
							/>{" "}
							{waiveLabel}
						</label>
					</div>
				)}
				<div class="mf">
					<button
						ref={cancelButton}
						type="button"
						class="btn"
						data-test="dialog-cancel"
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="button"
						class="btn p"
						data-test="dialog-confirm"
						onClick={() => onConfirm(waive)}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
