/** Ordering the Worker-safe read side shares: no import, so `read.ts` can use it and still pull in nothing else. */

/** Code-unit order, the order of object keys and of event ids (which sort as text). */
export const byText = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

/** Events in id order, the order `replayEvents` and `readEvents` use. */
export const byEventId = (a: { id: string }, b: { id: string }): number =>
	byText(a.id, b.id);
