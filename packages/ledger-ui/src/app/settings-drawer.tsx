import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { CoreIcon, type CoreIconName } from "./core-icon.tsx";
import { useFocusTrap } from "./focus-trap.ts";
import type { Theme } from "./route.ts";

const themes: Array<{ theme: Theme; label: string; icon: CoreIconName }> = [
	{ theme: "light", label: "Light", icon: "sun" },
	{ theme: "dark", label: "Dark", icon: "moon" },
	{ theme: "system", label: "System", icon: "monitor" },
];

type SettingsDrawerProps = {
	/** The id the settings button's `aria-controls` names. */
	id: string;
	open: boolean;
	/** "You and <school>", or "All schools". */
	subtitle: string;
	theme: Theme;
	onThemeChange: (theme: Theme) => void;
	onClose: () => void;
	/** A dialog sits over the drawer: Tab and Escape belong to it. */
	dialogOpen?: boolean;
	/** The school's settings, below Appearance. */
	children?: ComponentChildren;
};

/** The settings drawer (mockup `#set`, `settings()`), a modal dialog while open: the shell makes the rest of the app
 * inert, Tab and Shift+Tab stay inside it and Escape closes it (a popover inside catches its own Escape first, and a
 * dialog over it takes Tab and Escape while it is open). It holds its header and Appearance; the school's settings
 * (S7) come as its children. */
export function SettingsDrawer({
	id,
	open,
	subtitle,
	theme,
	onThemeChange,
	onClose,
	dialogOpen = false,
	children,
}: SettingsDrawerProps): JSX.Element {
	const drawer = useRef<HTMLElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	useFocusTrap(open && !dialogOpen, drawer, onClose);
	useEffect(() => {
		if (open) closeButton.current?.focus({ preventScroll: true });
	}, [open]);
	return (
		<aside
			ref={drawer}
			id={id}
			class={open ? "drawer on" : "drawer"}
			role="dialog"
			aria-modal={open ? "true" : undefined}
			aria-labelledby={titleId}
			inert={!open}
		>
			<button
				ref={closeButton}
				type="button"
				class="x"
				aria-label="Close"
				onClick={onClose}
			>
				×
			</button>
			<h3 id={titleId}>
				<CoreIcon name="gear" /> Settings
			</h3>
			<div class="mut" data-test="settings-subtitle">
				{subtitle}
			</div>
			<h5 data-test="settings-section" data-section="appearance">
				<CoreIcon name="sun" /> Appearance{" "}
				<span class="mut section-note">just for you</span>
			</h5>
			<div class="seg">
				{themes.map((option) => (
					<button
						key={option.theme}
						type="button"
						class={option.theme === theme ? "on" : undefined}
						aria-pressed={option.theme === theme}
						onClick={() => onThemeChange(option.theme)}
					>
						<CoreIcon name={option.icon} />
						{option.label}
					</button>
				))}
			</div>
			{children}
		</aside>
	);
}
