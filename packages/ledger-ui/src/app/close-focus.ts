/** Which kind of input came last. A drawer moves focus to its close button when it opens (so a screen reader and the
 * keyboard start inside it), but only a keyboard open should show the focus ring around it: the mockup's close button
 * is a bare ×. Browsers decide `:focus-visible` for a scripted focus from their own history, which a first paint or a
 * screenshot does not have, so the last input is tracked here. */
let lastInputWasKeyboard = false;
if (typeof window !== "undefined") {
	window.addEventListener(
		"keydown",
		() => {
			lastInputWasKeyboard = true;
		},
		true,
	);
	for (const pointerEvent of ["pointerdown", "mousedown", "touchstart"])
		window.addEventListener(
			pointerEvent,
			() => {
				lastInputWasKeyboard = false;
			},
			true,
		);
}

/** The attribute that hides the ring of a close button focused after a pointer open (see `.x` in theme.css). */
export const pointerFocusAttribute = "data-pointer-focus";

/** Moves focus to a drawer's close button. After a pointer open the ring stays hidden until focus leaves the button;
 * after a keyboard open it shows. */
export function focusCloseButton(button: HTMLElement): void {
	if (lastInputWasKeyboard) button.removeAttribute(pointerFocusAttribute);
	else {
		button.setAttribute(pointerFocusAttribute, "");
		button.addEventListener(
			"blur",
			() => button.removeAttribute(pointerFocusAttribute),
			{ once: true },
		);
	}
	button.focus({ preventScroll: true });
}
