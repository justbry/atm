import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { useFocusTrap } from "./focus-trap.ts";

type DialogProps = {
	/** "Mark no-show · Vibes of Light". */
	title: string;
	onClose: () => void;
	children: ComponentChildren;
};

/** The mockup's modal (`#md`): a title and the dialog's own body. Escape and a click on the backdrop close it; Tab
 * stays inside; focus starts on the body's `data-autofocus` control and returns to the button that opened it. */
export function Dialog({ title, onClose, children }: DialogProps): JSX.Element {
	const modal = useRef<HTMLDivElement>(null);
	const titleId = useId();
	useFocusTrap(true, modal, onClose);
	useEffect(() => {
		const opener = document.activeElement;
		modal.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
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
				if (event.target === event.currentTarget) onClose();
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
				{children}
			</div>
		</div>
	);
}
