/** "1 booking", "2 bookings": the count with its noun, regular plurals only. */
export const plural = (count: number, noun: string): string =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;
