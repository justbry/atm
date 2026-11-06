import type { JSX } from "preact";
import type { GatedSurface, LockPanel as Lock } from "../data/disclosure.ts";
import { Icon, type IconName } from "./icon.tsx";

/** What a gated surface shows instead of its figures (mockup `lockPanel`): who may see it, and when or how fine. A
 * surface that is a books surface names itself in `surface`; the panel is never an empty table or a 0. */
export function LockPanel({
	lock,
	surface,
	icon = "lock",
}: {
	lock: Lock;
	surface?: GatedSurface;
	icon?: IconName;
}): JSX.Element {
	return (
		<div
			class="klock"
			data-test="lock-panel"
			data-surface={surface}
			data-lock={lock.reason}
		>
			<Icon name={icon} />
			<h4 data-test="lock-who">{lock.who}</h4>
			<div class="mut" data-test="lock-when">
				{lock.when}
			</div>
		</div>
	);
}
