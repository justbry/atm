import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Dialog } from "./dialog.tsx";

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

/** The mockup's modal for No-show and for Release hold inside the cutoff: a title, the booking line, the waive box
 * where it applies, Cancel and the action. Focus starts on Cancel. */
export function BookingDialog({
	title,
	detail,
	confirmLabel,
	waiveLabel,
	onConfirm,
	onCancel,
}: BookingDialogProps): JSX.Element {
	const [waive, setWaive] = useState(false);
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
