/** "gift" → "Gift". */
export const capitalise = (word: string): string =>
	`${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

/** `1 event`, `2 events`. */
export const plural = (count: number, noun: string): string =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;
