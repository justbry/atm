import type {
	BookingsWriter,
	CancelBooking,
	RecordOutcome,
} from "./bookings.ts";
import type {
	Accepted,
	CancelBookingRequest,
	MembersWriter,
	RecordOutcomeRequest,
} from "./members.ts";
import type { LedgerWriter } from "./ledger.ts";
import type { PlansWriter } from "./plans.ts";

/** Both the Bookings tab (S2) and the Members tab (S4) record outcomes and cancel bookings, each with its own request
 * shape, so these two take either and answer what either needs. */
type SharedWrites = {
	recordOutcome(
		request: RecordOutcome | RecordOutcomeRequest,
	): ReturnType<BookingsWriter["recordOutcome"]>;
	cancelBooking(
		request: CancelBooking | CancelBookingRequest,
		// biome-ignore lint/suspicious/noConfusingVoidType: the Bookings tab's cancel answers nothing (S2's contract); the Members tab's answers `Accepted`
	): Promise<void | Accepted>;
};

/** The writes only the Members tab makes. */
const membersOnlyWrites = [
	"refund",
	"adjustCredits",
	"sendInvoice",
	"grantFinance",
	"revokeFinance",
	"changeRole",
	"switchTier",
	"cancelMembership",
	"resumeMembership",
] as const satisfies ReadonlyArray<keyof MembersWriter>;

/** Every change the UI makes goes through the Writer: fixtures now, the buzz-school routes in S8. Each slice adds the
 * methods its actions call: S2 the Bookings ones, S3 the Plans ones, S4 the Members ones, S5 the promo ones and the CSV downloads. A Writer built for an earlier slice has no
 * Members writes; the Members tab asks for them with `membersWritesOf`. */
export type Writer = SharedWrites &
	PlansWriter &
	LedgerWriter &
	Partial<Pick<MembersWriter, (typeof membersOnlyWrites)[number]>>;

/** The Writer as a `MembersWriter`; an error when it has no Members writes. */
export function membersWritesOf(writer: Writer): MembersWriter {
	const complete = (candidate: Writer): candidate is Writer & MembersWriter =>
		membersOnlyWrites.every((name) => typeof candidate[name] === "function");
	if (!complete(writer))
		throw new Error("The Members tab needs a Writer with the Members writes");
	return writer;
}
