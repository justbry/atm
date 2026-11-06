import { Fragment, type JSX } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import {
	adminReleaseReason,
	type Booking,
	type BookingBilling,
	insideCutoff,
	needsOutcome,
} from "../data/bookings.ts";
import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { BookingDialog } from "./booking-dialog.tsx";
import {
	cutoffHours,
	endSentence,
	failedToast,
	reminderToast,
	sentToast,
} from "./booking-text.ts";
import {
	type BookingsPeriod,
	bookingsDays,
	bookingsLabel,
	readBookingsPeriod,
} from "./bookings-period.ts";
import { Icon, type IconName } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { formatMoney } from "./money.ts";
import type { PaneProps } from "./panes.tsx";
import { addDays, monthAndDay, weekdayName } from "./period.ts";
import { plural } from "./plural.ts";
import { type Route, withQuery } from "./route.ts";
import { keepLoading } from "./use-loaded.ts";
import { exitPreviewTitle, useViewing } from "./viewing.ts";

type Filter = "outcome" | "approval" | "cutoff";
type View = BookingsPeriod & { filter: Filter | null };
type Dialog = { action: "noshow" | "release"; booking: Booking };

/** Brief A caps a range at 62 days: the overdue group reads that many days before the range. */
const overdueDays = 62;
const refundTitle = "Refunds from this tab are not available yet.";
const bookingsNote =
	"Credits are reserved when a booking is made, spent when it's attended, and released when it's cancelled before the item's cutoff. Cutoffs come from each item, not one school-wide number.";

/** The period (`range=` and `offset=`, shared with the top bar's control) and `filter=outcome|approval|cutoff`
 * (absent: all). */
function readView(query: URLSearchParams): View {
	const filter = query.get("filter");
	return {
		...readBookingsPeriod(query),
		filter:
			filter === "outcome" || filter === "approval" || filter === "cutoff"
				? filter
				: null,
	};
}

const bookingsLock = {
	reason: "admins_only",
	who: "Owners and admins see bookings",
	when: "Not a school-books surface: bookings carry minors' schedules (safeguarding), so they follow ManageBookings, not the audience.",
} as const;

const byStart = (first: Booking, second: Booking): number =>
	first.startsAt.localeCompare(second.startsAt);
const dayOf = ({ startsAt }: Booking): string => startsAt.slice(0, 10);
const attendeeName = ({ attendee }: Booking): string =>
	attendee?.name ?? "Guest";

type Check = (booking: Booking) => boolean;

function BillingBadge({
	billing,
	creditUnit,
}: {
	billing: BookingBilling | undefined;
	creditUnit: School["creditUnit"];
}): JSX.Element | null {
	if (!billing) return null;
	if (billing.kind === "free") return <span class="badge">Free</span>;
	if (billing.kind === "held")
		return (
			<span class="badge">
				<Icon name="clock" />
				{billing.credits}{" "}
				{billing.credits === 1 ? creditUnit.one : creditUnit.other} held
			</span>
		);
	return (
		<span class="badge">
			<Icon name="coin" />
			Paid {formatMoney(billing.amountMinor, billing.currency)}
		</span>
	);
}

type RowProps = {
	booking: Booking;
	withDate: boolean;
	pending: boolean;
	school: School;
	clock: Clock;
	onConfirm: (booking: Booking) => void;
	onNoShow: (booking: Booking) => void;
	onRelease: (booking: Booking) => void;
	onRemind: (booking: Booking) => void;
	onOpenMember: (booking: Booking) => void;
};

/** The status badges (mockup `bkStatus`): the write waiting to ship, else what the booking is waiting for. */
function statusBadges(
	booking: Booking,
	pending: boolean,
	clock: Clock,
): Array<{ text: string; tone: string }> {
	const badges: Array<{ text: string; tone: string }> = [];
	if (pending) badges.push({ text: "pending", tone: "b-warn" });
	if (booking.state === "requested")
		badges.push({ text: "Waiting for approval", tone: "b-warn" });
	if (needsOutcome(booking, clock) && !pending)
		badges.push({ text: "Needs outcome", tone: "b-bad" });
	else if (insideCutoff(booking, clock))
		badges.push({
			text: `Inside ${cutoffHours(booking.cutoffMinutes)} cutoff`,
			tone: "b-warn",
		});
	else if (booking.attendance)
		badges.push({
			text: booking.attendance === "attended" ? "Attended" : "No-show",
			tone: "",
		});
	if (booking.seriesLabel) badges.push({ text: booking.seriesLabel, tone: "" });
	return badges;
}

/** The row's buttons (mockup `bkActions`): Remind host on a booking waiting for approval, Confirm attended and No-show
 * on one that needs an outcome, then by billing Cancel and refund (paid) or Release hold (held, or not known); nothing
 * on a free booking. */
function RowActions({
	booking,
	pending,
	clock,
	onConfirm,
	onNoShow,
	onRelease,
	onRemind,
}: Omit<RowProps, "withDate" | "school" | "onOpenMember">): JSX.Element | null {
	const { preview } = useViewing();
	const writesOff = preview
		? { disabled: true, title: exitPreviewTitle }
		: undefined;
	if (pending)
		return (
			<span class="badge b-warn">
				<Icon name="clock" />
				waiting to ship
			</span>
		);
	if (booking.state === "requested")
		return (
			<button
				type="button"
				class="btn s"
				data-test="booking-action"
				data-action="remind"
				data-booking={booking.id}
				{...writesOff}
				onClick={() => onRemind(booking)}
			>
				<Icon name="mail" />
				Remind host
			</button>
		);
	if (needsOutcome(booking, clock))
		return (
			<>
				<button
					type="button"
					class="btn s"
					data-test="booking-action"
					data-action="confirm"
					data-booking={booking.id}
					{...writesOff}
					onClick={() => onConfirm(booking)}
				>
					<Icon name="check" />
					Confirm attended
				</button>
				<button
					type="button"
					class="btn s"
					data-test="booking-action"
					data-action="noshow"
					data-booking={booking.id}
					{...writesOff}
					onClick={() => onNoShow(booking)}
				>
					<Icon name="xCircle" />
					No-show
				</button>
			</>
		);
	if (booking.startsAt < clock.now || booking.billing?.kind === "free")
		return null;
	if (booking.billing?.kind === "paid") {
		const reasonId = `refund-reason-${booking.id}`;
		return (
			<>
				<button
					type="button"
					class="btn s"
					data-test="booking-action"
					data-action="refund"
					data-booking={booking.id}
					disabled
					title={refundTitle}
					aria-describedby={reasonId}
				>
					<Icon name="undo" />
					Cancel and refund
				</button>
				<span id={reasonId} class="visually-hidden">
					{refundTitle}
				</span>
			</>
		);
	}
	return (
		<button
			type="button"
			class="btn s"
			data-test="booking-action"
			data-action="release"
			data-booking={booking.id}
			{...writesOff}
			onClick={() => onRelease(booking)}
		>
			<Icon name="unlock" />
			Release hold
		</button>
	);
}

function BookingRow(props: RowProps): JSX.Element {
	const { booking, withDate, pending, school, clock } = props;
	const badges = statusBadges(booking, pending, clock);
	return (
		<tr class="row" data-test="booking-row" data-booking={booking.id}>
			<td class="mono" data-test="booking-time">
				{withDate ? `${monthAndDay(dayOf(booking))} ` : ""}
				{booking.startsAt.slice(11)}
			</td>
			<td>
				<b data-test="booking-service">{booking.service}</b>
				<div class="mono mut">
					{booking.id} · {booking.hosts.map(({ name }) => name).join(", ")}
				</div>
			</td>
			<td>
				{booking.attendee ? (
					<button
						type="button"
						class="member-open"
						data-test="booking-member"
						onClick={() => props.onOpenMember(booking)}
					>
						{attendeeName(booking)}
					</button>
				) : (
					<span data-test="booking-member">{attendeeName(booking)}</span>
				)}
				{booking.attendee && <div class="mono mut">{booking.attendee.key}</div>}
			</td>
			<td>
				<BillingBadge
					billing={booking.billing}
					creditUnit={school.creditUnit}
				/>
			</td>
			<td data-test="booking-status">
				{badges.map(({ text, tone }, index) => (
					<Fragment key={text}>
						{index > 0 && " "}
						<span class={tone ? `badge ${tone}` : "badge"}>{text}</span>
					</Fragment>
				))}
			</td>
			<td class="r">
				<div class="a">
					<RowActions
						booking={booking}
						pending={pending}
						clock={clock}
						onConfirm={props.onConfirm}
						onNoShow={props.onNoShow}
						onRelease={props.onRelease}
						onRemind={props.onRemind}
					/>
				</div>
			</td>
		</tr>
	);
}

type Group = {
	key: string;
	heading: string;
	icon: IconName;
	rows: Booking[];
	/** The overdue group's rows carry their date. */
	withDate: boolean;
};

type Loaded = {
	key: string;
	inRange: Booking[];
	before: Booking[];
	lateCancel: "spend" | "release";
};

/** One filter chip: the route's `filter=` value (null for All), its hook slug and its text. */
type Chip = { slug: "all" | Filter; filter: Filter | null; label: string };

/** The Bookings pane (mockup `bookings()`): one day or week of the school's bookings in day groups, preceded by the
 * overdue group (confirmed bookings that started before the range and have no outcome, from a second read over the 62
 * days before it). Which bookings need an outcome or sit inside their cutoff is the contract's `needsOutcome` and
 * `insideCutoff`; the Billing column is the Reader's `billing`; nothing is counted but the rows shown. Writes are
 * `recordOutcome` and `cancelBooking`, one per booking; a booking written stays "pending" until the ledger ships. */
export function Bookings({
	reader,
	writer,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
	pendingBookings: pending,
	onPendingBookings,
}: {
	reader: Reader;
	writer: Writer;
	school: School;
	clock: Clock;
	route: Route;
	navigate: (route: Route) => void;
	/** Called after each render that shows the list the route asks for. */
	onRendered: () => void;
	onToast: (text: string) => void;
	/** The school's bookings with a write on their way, kept by the shell (Members shows them too). */
	pendingBookings: ReadonlySet<string>;
	onPendingBookings: PaneProps["onPendingBookings"];
}): JSX.Element | null {
	const { option, preview } = useViewing();
	const view = readView(route.query);
	const { from, to } = bookingsDays(view, clock.today);
	const key = `${school.id}/${from}/${to}`;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const setPending = (
		update: (before: ReadonlySet<string>) => ReadonlySet<string>,
	): void => onPendingBookings(school.id, update);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	useEffect(() => {
		if (!option.admin) return;
		let current = true;
		const load = async (): Promise<void> => {
			const [inRange, before, summary] = await Promise.all([
				reader.bookings({ school: school.id, from, to }),
				reader.bookings({
					school: school.id,
					from: addDays(from, -overdueDays),
					to: addDays(from, -1),
				}),
				reader.membersSummary({ schoolId: school.id }),
			]);
			if (current)
				setLoaded({
					key,
					inRange: inRange.bookings,
					before: before.bookings,
					lateCancel: summary.bookingRules.lateCancel,
				});
		};
		load().catch(keepLoading);
		return () => {
			current = false;
		};
	}, [reader, school.id, from, to, key, option.admin]);
	const shown = loaded?.key === key ? loaded : null;
	useLayoutEffect(() => {
		if (shown || !option.admin) onRendered();
	});
	if (!option.admin) return <LockPanel lock={bookingsLock} icon="calendar" />;

	const waiting: Check = ({ id }) => pending.has(id);
	const canRecord: Check = (booking) =>
		needsOutcome(booking, clock) && !waiting(booking);
	const checks: Record<Filter, Check> = {
		outcome: canRecord,
		approval: ({ state }) => state === "requested",
		cutoff: (booking) => insideCutoff(booking, clock),
	};
	const overdue = (shown?.before ?? [])
		.filter((booking) => needsOutcome(booking, clock))
		.sort(byStart);
	const counted = [...overdue, ...(shown?.inRange ?? [])];
	const keep: Check = (booking) =>
		view.filter === null || checks[view.filter](booking);

	const groups: Group[] = [];
	const shownOverdue = overdue.filter(keep);
	if (shownOverdue.length > 0)
		groups.push({
			key: "overdue",
			heading: `Overdue: needs an outcome (${shownOverdue.length})`,
			icon: "alert",
			rows: shownOverdue,
			withDate: true,
		});
	const tomorrow = addDays(clock.today, 1);
	let emptyDay: string | null = null;
	for (let day = from; day <= to; day = addDays(day, 1)) {
		const rows = (shown?.inRange ?? [])
			.filter((booking) => dayOf(booking) === day && keep(booking))
			.sort(byStart);
		if (rows.length === 0) {
			if (from === to && shown) emptyDay = day;
			continue;
		}
		const when =
			day === clock.today ? " · Today" : day === tomorrow ? " · Tomorrow" : "";
		groups.push({
			key: day,
			heading: `${weekdayName(day)} ${monthAndDay(day)}${when} · ${plural(rows.length, "booking")}`,
			icon: "calendar",
			rows,
			withDate: false,
		});
	}

	/** Marks the bookings pending, runs one write each in row order, and toasts when the Writer has answered; a booking
	 * whose write failed is offered again. */
	const send = async (
		bookings: Booking[],
		write: (booking: Booking) => Promise<unknown>,
		done: string,
	): Promise<void> => {
		const ids = bookings.map(({ id }) => id);
		setPending((before) => new Set([...before, ...ids]));
		const results = await Promise.allSettled(bookings.map(write));
		const failed = ids.filter(
			(_, index) => results[index]?.status === "rejected",
		);
		if (failed.length > 0)
			setPending(
				(before) => new Set([...before].filter((id) => !failed.includes(id))),
			);
		onToast(failed.length === 0 ? done : failedToast);
	};
	const record = (booking: Booking, state: "attended" | "no_show") =>
		writer.recordOutcome({ school: school.id, bookingId: booking.id, state });
	const release = (booking: Booking, waiveCutoff?: boolean) =>
		writer.cancelBooking({
			school: school.id,
			bookingId: booking.id,
			reason: adminReleaseReason,
			...(waiveCutoff === undefined ? {} : { waiveCutoff }),
		});
	const confirm = (booking: Booking): void => {
		send(
			[booking],
			(each) => record(each, "attended"),
			`Attendance confirmed for ${endSentence(attendeeName(booking))}`,
		);
	};
	const confirmAll = (rows: Booking[]): void => {
		send(
			rows,
			(each) => record(each, "attended"),
			`Attendance confirmed for ${rows.length} bookings.`,
		);
	};
	const startRelease = (booking: Booking): void => {
		const forfeits =
			insideCutoff(booking, clock) && shown?.lateCancel === "spend";
		if (forfeits) setDialog({ action: "release", booking });
		else
			send(
				[booking],
				(each) => release(each),
				`Hold released for ${endSentence(attendeeName(booking))}`,
			);
	};
	const confirmDialog = (waiveCutoff: boolean): void => {
		if (!dialog) return;
		const { action, booking } = dialog;
		setDialog(null);
		send(
			[booking],
			(each) =>
				action === "noshow"
					? record(each, "no_show")
					: release(each, waiveCutoff),
			sentToast,
		);
	};

	const chooseFilter = (filter: Filter | null): void =>
		navigate(withQuery(route, "filter", filter));
	const remind = ({ hosts }: Booking): void =>
		onToast(reminderToast(hosts.map(({ name }) => name)));
	/** The member's drawer is the Members tab's; the shared parameters stay and this tab's `filter=` goes. */
	const openMember = ({ attendee }: Booking): void => {
		if (!attendee) return;
		const { query } = withQuery(route, "filter", null);
		query.set("member", attendee.key);
		navigate({ ...route, tab: "members", query });
	};
	/** A chip's count is the rows counted, so it waits for the read rather than showing 0. */
	const counting = (label: string, check: Check): string =>
		shown ? `${label} (${counted.filter(check).length})` : label;
	const chips: Chip[] = [
		{ slug: "all", filter: null, label: "All" },
		{
			slug: "outcome",
			filter: "outcome",
			label: counting("Needs outcome", checks.outcome),
		},
		{
			slug: "approval",
			filter: "approval",
			label: counting("Waiting for approval", checks.approval),
		},
		{
			slug: "cutoff",
			filter: "cutoff",
			label: counting("Inside cutoff", checks.cutoff),
		},
	];
	const onThisWeek = view.range === "week" && view.offset === 0;
	const dialogLine = dialog
		? [
				dialog.booking.service,
				dialog.booking.id,
				attendeeName(dialog.booking),
				dialog.booking.attendee?.key,
			]
				.filter(Boolean)
				.join(" · ")
		: "";

	let body: JSX.Element[] = groups.flatMap((group) => {
		const needing = group.rows.filter(canRecord);
		return [
			<tr
				key={group.key}
				class="day"
				data-test="booking-day"
				data-day={group.key}
			>
				<td colSpan={6}>
					<Icon name={group.icon} /> {group.heading}
					{needing.length > 1 && (
						<button
							type="button"
							class="btn s bookings-bulk"
							data-test="booking-bulk"
							data-day={group.key}
							{...(preview && { disabled: true, title: exitPreviewTitle })}
							onClick={() => confirmAll(needing)}
						>
							<Icon name="check" />
							Confirm all attended ({needing.length})
						</button>
					)}
				</td>
			</tr>,
			...group.rows.map((booking) => (
				<BookingRow
					key={booking.id}
					booking={booking}
					withDate={group.withDate}
					pending={waiting(booking)}
					school={school}
					clock={clock}
					onConfirm={confirm}
					onNoShow={(chosen) =>
						setDialog({ action: "noshow", booking: chosen })
					}
					onRelease={startRelease}
					onRemind={remind}
					onOpenMember={openMember}
				/>
			)),
		];
	});
	if (emptyDay)
		body = [
			...body,
			<tr key="empty-day" data-test="booking-empty">
				<td colSpan={6} class="mut bookings-empty bookings-empty-day">
					Nothing booked on {monthAndDay(emptyDay)}.
				</td>
			</tr>,
		];
	if (shown && body.length === 0)
		body = [
			<tr key="empty" data-test="booking-empty">
				<td colSpan={6} class="mut bookings-empty">
					<Icon name="check" /> No bookings{" "}
					{view.filter ? "match" : "in this period"}.
					{onThisWeek ? "" : " Try This week."}
				</td>
			</tr>,
		];

	return (
		<>
			<div class="tools">
				<b data-test="booking-range-label">{bookingsLabel(view, from)}</b>
				<span class="mut" data-test="booking-range-dates">
					{monthAndDay(from)}
					{from === to ? "" : ` – ${monthAndDay(to)}`} · change it in the period
					control
				</span>
				<span class="sp" />
				{chips.map(({ slug, filter, label }) => (
					<button
						key={slug}
						type="button"
						class={filter === view.filter ? "chip on" : "chip"}
						aria-pressed={filter === view.filter}
						data-test="booking-filter"
						data-filter={slug}
						onClick={() => chooseFilter(filter)}
					>
						{label}
					</button>
				))}
			</div>
			<table>
				<thead>
					<tr>
						<th class="bookings-when">When</th>
						<th>Booking</th>
						<th>Member</th>
						<th>Billing</th>
						<th>Status</th>
						<th>
							<span class="visually-hidden">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>{body}</tbody>
			</table>
			<p class="mut bookings-note" data-test="booking-note">
				<Icon name="info" /> {bookingsNote}
			</p>
			{dialog && (
				<BookingDialog
					title={`${dialog.action === "noshow" ? "Mark no-show" : "Release hold"} · ${school.name}`}
					detail={dialogLine}
					confirmLabel={
						dialog.action === "noshow" ? "Mark no-show" : "Release hold"
					}
					waiveLabel={
						dialog.action === "release"
							? `Waive the late-cancel forfeit (return the ${school.creditUnit.other})`
							: undefined
					}
					onConfirm={confirmDialog}
					onCancel={() => setDialog(null)}
				/>
			)}
		</>
	);
}
