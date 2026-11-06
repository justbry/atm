import type { ComponentChildren, JSX } from "preact";
import { Icon } from "./icon.tsx";

/** The mockup's `lockPanel`: who may see a surface and why it is not shown, in place of an empty table or a 0 (spec v2).
 * Every audience that lacks a grant gets this one (`no_grant`). */
export function LockPanel({
	title,
	children,
}: {
	title: string;
	children: ComponentChildren;
}): JSX.Element {
	return (
		<div class="klock" data-test="lock-panel" data-lock="no_grant">
			<Icon name="lock" />
			<h4 data-test="lock-title">{title}</h4>
			<div class="mut" data-test="lock-body">
				{children}
			</div>
		</div>
	);
}
