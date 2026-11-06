/** The mockup's `fmtCut`: whole hours, else one decimal. */
export function cutoffHours(cutoffMinutes: number): string {
	const hours = cutoffMinutes / 60;
	return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** A name that ends in a full stop ("Ana P.") ends the sentence too. */
export const endSentence = (text: string): string =>
	text.endsWith(".") ? text : `${text}.`;

/** A write the server has taken (bookings, the Members tab): it shows as pending until the ledger ships. */
export const sentToast =
	"Sent. It shows as pending, then in the ledger after the next ship (≤5 min).";
/** A write that did not reach the server (bookings, Members, the member portal, promos). */
export const failedToast = "Could not send. Try again.";

/** The toast after "Remind host" (bookings, the Members drawer): who was reminded. */
export const reminderToast = (hostNames: readonly string[]): string =>
	`Reminder sent to ${hostNames.join(", ")}.`;
