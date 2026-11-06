import type { ComponentChildren, JSX } from "preact";
import { createContext } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

/** True inside a `DialogSlot`: the slot's owner returns focus when the last dialog of a chain closes (`useSlotOpener`),
 * so a dialog that replaces another neither returns it nor takes it over. */
export const inSlot = createContext(false);

/** Wraps the dialogs a slot shows (the shell's modal slot, Promos). */
export function DialogSlot({
	children,
}: {
	children: ComponentChildren;
}): JSX.Element {
	return <inSlot.Provider value={true}>{children}</inSlot.Provider>;
}

/** The slot owner's half: while `open` goes from false to true the control with focus is the opener; a dialog that
 * replaces another keeps `open` true, so the opener stays; when `open` goes back to false focus returns to it. */
export function useSlotOpener(open: boolean): void {
	const opener = useRef<HTMLElement | null>(null);
	const wasOpen = useRef(false);
	/* A layout effect runs before the dialog's own effect moves focus into it. */
	useLayoutEffect(() => {
		if (open === wasOpen.current) return;
		wasOpen.current = open;
		if (open) {
			opener.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
			return;
		}
		const target = opener.current;
		opener.current = null;
		if (target?.isConnected) target.focus();
	});
}
