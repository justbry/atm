import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ConsequenceLine } from "./booking-text.ts";
import { Dialog } from "./dialog.tsx";

type BookingDialogProps = {
	/** "Mark no-show · Vibes of Light". */
	title: string;
	/** The booking line: item, booking id, member and member key. */
	detail: string;
	confirmLabel: string;
	/** The label of the "Waive the late-cancel forfeit" box, for a release inside the cutoff; without it, no box. */
	waiveLabel?: string | undefined;
	/** What the action does to the member's credits, from the Waive box; null (or nothing) leaves the line out. */
	consequence?: ((waive: boolean) => ConsequenceLine | null) | undefined;
	onConfirm: (waiveCutoff: boolean) => void;
	onCancel: () => void;
};

/** The mockup's modal for No-show and for Release hold inside the cutoff: a title, the booking line, the waive box
 * where it applies, Cancel and the action. Focus starts on Cancel. */
export function BookingDialog({
	title,
	detail,
	confirmLabel,
	waiveLabel,
	consequence,
	onConfirm,
	onCancel,
}: BookingDialogProps): JSX.Element {
	const [waive, setWaive] = useState(false);
	const line = consequence?.(waive);
	return (
		<Dialog title={title} onClose={onCancel}>
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
			{line && (
				<div class="prev" aria-live="polite">
					{line.before}
					{line.strong && <b>{line.strong}</b>}
					{line.after}
				</div>
			)}
			<div class="mf">
				<button
					type="button"
					class="btn"
					data-test="dialog-cancel"
					data-autofocus
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
		</Dialog>
	);
}
