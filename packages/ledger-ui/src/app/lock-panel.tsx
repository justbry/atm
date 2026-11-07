import type { JSX } from "preact";
import type { GatedSurface, LockPanel as Lock } from "../data/disclosure.ts";
import { Icon, type IconName } from "./icon.tsx";

/** The hooks of the panel's heading and of the line under it, as each golden file names them: the disclosure
 * contract's panels (S7) `lock-who` and `lock-when`, the Members roster's (S4) `lock-title` and `lock-text`, the
 * books panes' (S5) `lock-title` and `lock-body`. */
const hookNames = {
	disclosure: { heading: "lock-who", line: "lock-when" },
	roster: { heading: "lock-title", line: "lock-text" },
	books: { heading: "lock-title", line: "lock-body" },
} as const;

/** What a gated surface shows instead of its figures (mockup `lockPanel`): who may see it, and when or how fine. A
 * surface that is a books surface names itself in `surface`; the panel is never an empty table or a 0. */
export function LockPanel({
	lock,
	surface,
	icon = "lock",
	hooks = "disclosure",
}: {
	lock: Lock;
	surface?: GatedSurface;
	icon?: IconName;
	hooks?: keyof typeof hookNames;
}): JSX.Element {
	const { heading, line } = hookNames[hooks];
	return (
		<div
			class="klock"
			data-test="lock-panel"
			data-surface={surface}
			data-lock={lock.reason}
		>
			<Icon name={icon} />
			<h4 data-test={heading}>{lock.who}</h4>
			<div class="mut" data-test={line}>
				{lock.when}
			</div>
		</div>
	);
}
