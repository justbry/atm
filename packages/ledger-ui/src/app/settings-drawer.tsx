import type { JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon, type IconName } from "./icon.tsx";
import type { Theme } from "./route.ts";

const themes: Array<{ theme: Theme; label: string; icon: IconName }> = [
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
};

const focusableSelector =
	"button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** The settings drawer (mockup `#set`, `settings()`), a modal dialog while open: the shell makes the rest of the app
 * inert, Tab and Shift+Tab stay inside it and Escape closes it (a popover inside catches its own Escape first). S0 has its header and Appearance; S7 adds the school's
 * settings. */
export function SettingsDrawer({
	id,
	open,
	subtitle,
	theme,
	onThemeChange,
	onClose,
}: SettingsDrawerProps): JSX.Element {
	const drawer = useRef<HTMLElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	useEffect(() => {
		if (!open) return;
		closeButton.current?.focus();
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				onClose();
				return;
			}
			if (event.key !== "Tab" || !drawer.current) return;
			const focusable = [
				...drawer.current.querySelectorAll<HTMLElement>(focusableSelector),
			];
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const focused = document.activeElement;
			const outside = !(focused && drawer.current.contains(focused));
			const edge = event.shiftKey ? first : last;
			if (!(outside || focused === edge)) return;
			event.preventDefault();
			(event.shiftKey ? last : first)?.focus();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);
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
				<Icon name="gear" /> Settings
			</h3>
			<div class="mut">{subtitle}</div>
			<h5>
				<Icon name="sun" /> Appearance{" "}
				<span class="mut appearance-note">just for you</span>
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
						<Icon name={option.icon} />
						{option.label}
					</button>
				))}
			</div>
		</aside>
	);
}
