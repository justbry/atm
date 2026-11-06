/** The mockup's `fmtCut`: whole hours, else one decimal. */
export function cutoffHours(cutoffMinutes: number): string {
	const hours = cutoffMinutes / 60;
	return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** A name that ends in a full stop ("Ana P.") ends the sentence too. */
export const endSentence = (text: string): string =>
	text.endsWith(".") ? text : `${text}.`;
