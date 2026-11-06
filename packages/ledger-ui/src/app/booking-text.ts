import type { Booking } from "../data/bookings.ts";
import type { MembersSummary } from "../data/members.ts";
import type { School } from "../data/types.ts";

type BookingRules = MembersSummary["bookingRules"];
type CreditUnit = School["creditUnit"];

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

/** A reminder the server did not take (bookings, the Members drawer). */
export const reminderFailedToast = "Could not send the reminder. Try again.";

/** The toast after "Remind host" (bookings, the Members drawer): who was reminded. */
export const reminderToast = (hostNames: readonly string[]): string =>
	`Reminder sent to ${hostNames.join(", ")}.`;

/** The consequence line of the No-show and inside-cutoff Release dialogs (mockup `ACT.noshow.prev`, `ACT.release.prev`):
 * `strong` is the part the mockup sets in bold. */
export type ConsequenceLine = { before: string; strong: string; after: string };

const creditCount = (count: number, unit: CreditUnit): string =>
	`${count} ${count === 1 ? unit.one : unit.other}`;

/** Built only from the school's rules, the booking's `billing` and the attendee's name; with no `billing` there is no
 * line, and no balance is computed. A no-show on a booking holding no credits says so. */
export function consequenceLine({
	action,
	waive,
	rules,
	booking,
	creditUnit,
	memberName,
}: {
	action: "noshow" | "release";
	/** The "Waive the late-cancel forfeit" box. */
	waive: boolean;
	rules: BookingRules;
	booking: Pick<Booking, "billing" | "cutoffMinutes">;
	creditUnit: CreditUnit;
	memberName: string;
}): ConsequenceLine | null {
	const { billing } = booking;
	if (!billing) return null;
	const credits = billing.kind === "held" ? billing.credits : 0;
	if (action === "noshow") {
		if (credits === 0)
			return {
				before: "No credits are involved. The no-show is recorded.",
				strong: "",
				after: "",
			};
		const count = creditCount(credits, creditUnit);
		return rules.noShow === "spend"
			? {
					before: `Rule: a no-show spends the ${creditUnit.other}. `,
					strong: count,
					after: " are spent.",
				}
			: {
					before: `Rule: a no-show releases the ${creditUnit.other}. `,
					strong: count,
					after: " return to available.",
				};
	}
	if (billing.kind !== "held") return null;
	const count = creditCount(credits, creditUnit);
	if (rules.lateCancel === "spend" && !waive)
		return {
			before: `Inside the ${cutoffHours(booking.cutoffMinutes)} cutoff, the school's rule `,
			strong: `forfeits ${count}`,
			after: '. Tick "Waive" to return them.',
		};
	return {
		before: "",
		strong: count,
		after: ` return to ${memberName}'s available balance.`,
	};
}
