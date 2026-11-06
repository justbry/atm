import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon, type IconName } from "./icon.tsx";
import type { Theme } from "./route.ts";

const themes: Array<{ theme: Theme; label: string; icon: IconName }> = [
	{ theme: "light", label: "Light", icon: "sun" },
	{ theme: "dark", label: "Dark", icon: "moon" },
	{ theme: "system", label: "System", icon: "monitor" },
];

type SettingsDrawerProps = {
	open: boolean;
	/** "You and <school>", or "All schools". */
	subtitle: string;
	theme: Theme;
	onThemeChange: (theme: Theme) => void;
	onClose: () => void;
};

/** The settings drawer (mockup `#set`, `settings()`): S0 has its header and Appearance; S7 adds the school's
 * settings. */
export function SettingsDrawer({
	open,
	subtitle,
	theme,
	onThemeChange,
	onClose,
}: SettingsDrawerProps): JSX.Element {
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		closeButton.current?.focus();
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);
	return (
		<aside
			class={open ? "drawer on" : "drawer"}
			aria-label="Settings"
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
			<h3>
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
