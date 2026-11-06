import type { JSX } from "preact";
import { Icon } from "./icon.tsx";

/** A pane whose read the Reader rejected: it says what it could not load and offers to read again. */
export function LoadFailed({
	what,
	onRetry,
}: {
	/** "the ledger". */
	what: string;
	onRetry: () => void;
}): JSX.Element {
	return (
		<div class="note" role="alert">
			<Icon name="alert" />
			<span>Could not load {what}. Try again.</span>
			<span class="sp" />
			<button type="button" class="btn s" onClick={onRetry}>
				Try again
			</button>
		</div>
	);
}
