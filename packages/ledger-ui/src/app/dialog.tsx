import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { useFocusTrap } from "./focus-trap.ts";

/** The hooks of the modal and of its title, as each golden file names them: `dialog` and `dialog-title` (Bookings,
 * Promos, the member portal, Settings), `modal` and `modal-title` (Members), `plan-publish-dialog` without a title
 * hook (Plans). */
const hookNames = {
	dialog: { modal: "dialog", title: "dialog-title" },
	modal: { modal: "modal", title: "modal-title" },
	publish: { modal: "plan-publish-dialog", title: undefined },
} as const;

/** Set on a backdrop once its dialog has taken focus. */
const settledAttribute = "data-settled";
/** The control that opened a dialog which has just closed, until the dialog replacing it (if any) takes it over. */
let openerHandedOver: HTMLElement | null = null;

type DialogProps = {
	/** "Mark no-show · Vibes of Light". */
	title: ComponentChildren;
	onClose: () => void;
	/** A write is on its way: Escape and the backdrop leave the dialog open. */
	busy?: boolean;
	hooks?: keyof typeof hookNames;
	children: ComponentChildren;
};

/** The mockup's modal (`#md`), the one every dialog of the app is drawn in: a title and the dialog's own body.
 * Escape and a click on the backdrop close it unless it is busy; an Escape inside is the dialog's alone (a drawer
 * behind it stays open); Tab stays inside; focus starts on the body's `data-autofocus` control, else its first field or
 * button, and returns to the control that opened it (unless another dialog takes its place, which then returns there).
 * The backdrop is fixed to the viewport, so the title shows wherever the page or a drawer is scrolled. */
export function Dialog({
	title,
	onClose,
	busy = false,
	hooks = "dialog",
	children,
}: DialogProps): JSX.Element {
	const backdrop = useRef<HTMLDivElement>(null);
	const modal = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const close = (): void => {
		if (!busy) onClose();
	};
	useFocusTrap(true, modal, close);
	useEffect(() => {
		const opener = openerHandedOver ?? document.activeElement;
		openerHandedOver = null;
		backdrop.current?.setAttribute(settledAttribute, "");
		const first =
			modal.current?.querySelector<HTMLElement>("[data-autofocus]") ??
			modal.current?.querySelector<HTMLElement>(
				"input, select, textarea, button:not([disabled])",
			);
		first?.focus({ preventScroll: true });
		return () => {
			if (!(opener instanceof HTMLElement)) return;
			/* A dialog that replaces this one in the same commit has not run its effect yet: it takes the opener over, so
			 * focus does not jump back to a control deep in the page (scrolling it) between two dialogs. */
			openerHandedOver = opener;
			window.setTimeout(() => {
				const takenOver = openerHandedOver !== opener;
				const aboutToTakeOver = document.querySelector(
					`.bg:not([${settledAttribute}])`,
				);
				if (takenOver || aboutToTakeOver) return;
				openerHandedOver = null;
				if (opener.isConnected) opener.focus();
			}, 0);
		};
	}, []);
	const { modal: modalHook, title: titleHook } = hookNames[hooks];
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the dialog (useFocusTrap); a click on the backdrop is a pointer shortcut for the same
		<div
			ref={backdrop}
			class="bg on"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div
				ref={modal}
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-test={modalHook}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					close();
				}}
			>
				<h3 id={titleId} data-test={titleHook}>
					{title}
				</h3>
				{children}
			</div>
		</div>
	);
}
