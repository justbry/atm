/**
 * The names a Pay later instalment carries through Stripe and the books (`pay-later.ts`), kept apart so the handler reads
 * them without importing tfd-notes.
 */

/** Invoice metadata: the note an instalment pays. */
export const PAY_LATER_NOTE_FIELD = "b4u_note";
/** Invoice metadata: which instalment of the note's schedule (1-based). */
export const PAY_LATER_INSTALMENT_FIELD = "b4u_instalment";
/** The income account tail of an instalment: `income:billing:pay-later`. */
export const PAY_LATER_INCOME_KIND = "pay-later";
