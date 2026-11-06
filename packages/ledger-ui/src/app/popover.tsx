import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";

type PopoverProps = {
	/** The trigger's class and hooks; the trigger is always a real button. */
	trigger: {
		class: string;
		"data-test": string;
		/** The id the mockup's stylesheet addresses the button by (`#sw`, `#pb`, `#kview`, `#gb`). */
		id?: string;
		"aria-label"?: string;
		"aria-haspopup"?: "listbox" | "dialog" | "menu";
		title?: string | undefined;
		disabled?: boolean | undefined;
	};
	label: ComponentChildren;
	alignRight?: boolean;
	/** The wrapper's class, which the stylesheet's narrow-width order and positions address (`tsw`, `tper`, `tva`,
	 * `thb`). */
	wrapperClass?: string;
	/** The panel's class (`pop` by default, `menu` for a menu) and, when the stylesheet addresses it, its id. */
	panelClass?: string;
	panelId?: string;
	/** The panel's role and name, when the panel itself is the popup (the period dialog, the View as list). */
	panel?: { role: "dialog" | "listbox"; "aria-label": string };
	/** The id the open trigger's `aria-controls` names, when the popup sits inside the panel (the switcher's
	 * listbox). */
	controls?: string;
	/** The popover's content; `close` shuts it and returns focus to the trigger. */
	children: (close: () => void) => ComponentChildren;
};

/** The mockup's `.pw` / `.pop`: a button that discloses a panel. Escape or a click outside closes it and returns focus
 * to the button (unless the click put focus somewhere else), and opening another popover closes this one (that click
 * is outside it). Escape is caught before anything else hears it, so a drawer around the popover stays open. */
export function Popover({
	trigger,
	label,
	alignRight = false,
	wrapperClass,
	panelClass = "pop",
	panelId: panelIdentifier,
	panel,
	controls,
	children,
}: PopoverProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const wrapper = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const generatedId = useId();
	const panelId = panelIdentifier ?? generatedId;
	const close = (): void => {
		setOpen(false);
		button.current?.focus();
	};
	useEffect(() => {
		if (!open) return;
		const onClick = (event: MouseEvent): void => {
			const inside =
				event.target instanceof Node && wrapper.current?.contains(event.target);
			if (inside) return;
			setOpen(false);
			const focused = document.activeElement;
			const focusLost =
				!focused ||
				focused === document.body ||
				wrapper.current?.contains(focused);
			if (focusLost) button.current?.focus();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setOpen(false);
			button.current?.focus();
		};
		document.addEventListener("click", onClick);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("click", onClick);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open]);
	return (
		<div class={wrapperClass ? `pw ${wrapperClass}` : "pw"} ref={wrapper}>
			<button
				{...trigger}
				type="button"
				ref={button}
				aria-expanded={open}
				aria-controls={open ? (controls ?? panelId) : undefined}
				onClick={() => setOpen(!open)}
			>
				{label}
			</button>
			{open && (
				<div
					{...panel}
					id={panelId}
					class={alignRight ? `${panelClass} r on` : `${panelClass} on`}
				>
					{children(close)}
				</div>
			)}
		</div>
	);
}
