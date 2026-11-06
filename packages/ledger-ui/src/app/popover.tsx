import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";

type PopoverProps = {
	/** The trigger's class and hooks; the trigger is always a real button. */
	trigger: {
		class: string;
		"data-test": string;
		"aria-label"?: string;
		"aria-haspopup"?: "listbox" | "dialog";
		title?: string;
	};
	label: ComponentChildren;
	alignRight?: boolean;
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
	children,
}: PopoverProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const wrapper = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const panelId = useId();
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
		<div class="pw" ref={wrapper}>
			<button
				{...trigger}
				type="button"
				ref={button}
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen(!open)}
			>
				{label}
			</button>
			{open && (
				<div id={panelId} class={alignRight ? "pop r on" : "pop on"}>
					{children(close)}
				</div>
			)}
		</div>
	);
}
