import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "./icon.tsx";

const pinDigits = 4;

/** The PIN prompt (mockup `bkLock`): Unlock opens once 4 digits are typed. The fixtures check no PIN. The books panes
 * show it from governance up when the route says `pin=locked`. */
export function PinLock({
	levelName,
	onUnlock,
}: {
	levelName: string;
	onUnlock: () => void;
}): JSX.Element {
	const [pin, setPin] = useState("");
	return (
		<div class="klock" data-test="pin-lock">
			<Icon name="lock" />
			<h4>Enter your PIN to see books</h4>
			<div class="mut">
				{levelName} opens the books with your family PIN. Nothing is shown until
				you unlock.
			</div>
			<div class="fld">
				<label>
					Your family PIN
					<input
						class="bpin"
						type="password"
						inputMode="numeric"
						maxLength={6}
						autoComplete="off"
						aria-label="Your family PIN"
						data-test="pin-input"
						value={pin}
						onInput={(event) => setPin(event.currentTarget.value)}
					/>
				</label>
			</div>
			<button
				type="button"
				class="btn p"
				data-test="pin-unlock"
				disabled={pin.length < pinDigits}
				onClick={onUnlock}
			>
				<Icon name="unlock" />
				Unlock
			</button>
		</div>
	);
}
