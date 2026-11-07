import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

const focusableSelector =
	"button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** While `active`, Escape calls `onClose` and Tab and Shift+Tab stay inside `container`: the keyboard half of a modal
 * dialog (the drawer and the Bookings dialog). A popover inside catches its own Escape first. */
export function useFocusTrap(
	active: boolean,
	container: RefObject<HTMLElement>,
	onClose: () => void,
): void {
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				onClose();
				return;
			}
			if (event.key !== "Tab" || !container.current) return;
			const focusable = [
				...container.current.querySelectorAll<HTMLElement>(focusableSelector),
			];
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const focused = document.activeElement;
			const outside = !(focused && container.current.contains(focused));
			const edge = event.shiftKey ? first : last;
			if (!(outside || focused === edge)) return;
			event.preventDefault();
			(event.shiftKey ? last : first)?.focus();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [active, container, onClose]);
}
