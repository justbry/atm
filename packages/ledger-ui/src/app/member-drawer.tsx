import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
	financeOnly,
	type MemberBooking,
	previewLock,
} from "../data/members.ts";
import type { School } from "../data/types.ts";
import { useFocusTrap } from "./focus-trap.ts";
import { Icon, type IconName } from "./icon.tsx";
import {
	type MenuAction,
	MenuButton,
	type PersonContext,
} from "./member-menu.tsx";
import {
	AttentionBadges,
	BalanceBar,
	FinanceChip,
	RoleChip,
} from "./member-parts.tsx";
import {
	amountText,
	attentionOf,
	audienceNames,
	capabilityReason,
	countOf,
	cutoffHours,
	eventColors,
	eventLabel,
	formatDay,
	formatMoney,
	formatPaymentDay,
	formatWallTime,
	historyOf,
	paymentsOf,
	pendingBookingIds,
	project,
	signed,
	standingOf,
} from "./members-model.ts";
import { monthAndDay } from "./period.ts";

/** A booking button of the drawer (the golden file's `data-action`). */
export type BookingAction =
	| "confirm"
	| "noshow"
	| "release"
	| "refund"
	| "remind";

const shortList = 5;
function FinanceOnly(): JSX.Element {
	return (
		<span class="khid" title={financeOnly.title}>
			{financeOnly.text}
		</span>
	);
}

type DrawerProps = {
	context: PersonContext;
	school: School;
	unit: { one: string; other: string };
	today: string;
	/** The ⋯ button is open on this drawer. */
	menuOpen: boolean;
	/** The drawer takes Tab and Escape while nothing above it does. */
	trapActive: boolean;
	/** The booking button whose call is on its way. */
	busy: { bookingId: string; action: BookingAction } | null;
	onMenu: (button: HTMLElement, focusFirst: boolean) => void;
	onClose: () => void;
	onAction: (action: MenuAction) => void;
	onBookingAction: (action: BookingAction, booking: MemberBooking) => void;
};

/** A button of the drawer: off with its reason as the title, or while a preview is on; busy while its call is on its
 * way. */
function DrawerButton({
	icon,
	label,
	reason,
	locked,
	tone,
	hook,
	action,
	bookingId,
	busy,
	onClick,
}: {
	icon: IconName;
	label: string;
	reason: string;
	locked: boolean;
	/** `p` is the primary button, `s` the small one of a booking row. */
	tone?: "p" | "s";
	hook: "drawer-action" | "booking-action";
	action: MenuAction | BookingAction;
	bookingId?: string;
	busy?: boolean;
	onClick: () => void;
}): JSX.Element {
	const why = locked ? previewLock : reason;
	return (
		<button
			type="button"
			class={tone === undefined ? "btn" : `btn ${tone}`}
			data-test={hook}
			data-action={action}
			data-booking={bookingId}
			disabled={why !== "" || busy === true}
			aria-busy={busy ? "true" : undefined}
			title={why === "" ? undefined : why}
			onClick={onClick}
		>
			<Icon name={icon} />
			{label}
		</button>
	);
}

function BookingRow({
	booking,
	context,
	unit,
	currency,
	busy,
	onAction,
}: {
	booking: MemberBooking;
	context: PersonContext;
	unit: DrawerProps["unit"];
	currency: string;
	busy: DrawerProps["busy"];
	onAction: DrawerProps["onBookingAction"];
}): JSX.Element {
	const { person, capabilities, viewer, changes } = context;
	const waiting = pendingBookingIds(changes).has(booking.id);
	const reasons = person.attention.filter(
		(reason) => reason.bookingId === booking.id,
	);
	const needsOutcome = reasons.some(({ kind }) => kind === "needs_outcome");
	const inside = reasons.some(({ kind }) => kind === "inside_cutoff");
	const locked = viewer.preview;
	const own = capabilities.role === "owner";
	const refundReason = capabilityReason(capabilities, "refund", "drawer");
	const button = (
		action: BookingAction,
		icon: IconName,
		label: string,
		reason = "",
	): JSX.Element => (
		<DrawerButton
			icon={icon}
			label={label}
			reason={reason}
			locked={locked && action !== "remind"}
			tone="s"
			hook="booking-action"
			action={action}
			bookingId={booking.id}
			busy={busy?.bookingId === booking.id && busy.action === action}
			onClick={() => onAction(action, booking)}
		/>
	);
	return (
		<div class="bk" data-test="drawer-booking">
			<div>
				<b>{booking.service}</b>{" "}
				<span class="mut">· {formatWallTime(booking.startsAt)}</span>
				<div class="mono mut">
					{booking.id} · {booking.hosts.join(", ")}
				</div>
				<div>
					{booking.paidCents !== null ? (
						<span class="badge">
							<Icon name="coin" />
							Paid {formatMoney(booking.paidCents, currency)}
						</span>
					) : booking.creditsHeld > 0 ? (
						<span class="badge">
							<Icon name="clock" />
							{countOf(booking.creditsHeld, unit)} held
						</span>
					) : (
						<span class="badge">Free</span>
					)}{" "}
					{waiting && <span class="badge b-warn">pending</span>}
					{booking.state === "requested" && (
						<span class="badge b-warn">Waiting for approval</span>
					)}
					{needsOutcome && !waiting && (
						<span class="badge b-bad">Needs outcome</span>
					)}
					{!needsOutcome && inside && !waiting && (
						<span class="badge b-warn">
							Inside {cutoffHours(booking.cutoffMinutes)} cutoff
						</span>
					)}
					{booking.series !== null && (
						<span class="badge">{booking.series}</span>
					)}
				</div>
			</div>
			<div class="a">
				{waiting ? (
					<span class="badge b-warn">
						<Icon name="clock" />
						waiting to ship
					</span>
				) : booking.state === "requested" ? (
					button("remind", "mail", "Remind host")
				) : needsOutcome ? (
					<>
						{button(
							"confirm",
							"check",
							"Confirm attended",
							capabilityReason(capabilities, "recordOutcome", "drawer"),
						)}
						{button(
							"noshow",
							"xCircle",
							"No-show",
							capabilityReason(capabilities, "recordOutcome", "drawer"),
						)}
					</>
				) : booking.paidCents !== null ? (
					button(
						"refund",
						"undo",
						"Cancel and refund",
						own && refundReason === ""
							? ""
							: "Refunds need the owner role and a Stripe key with refund permission",
					)
				) : booking.creditsHeld > 0 ? (
					button(
						"release",
						"unlock",
						"Release hold",
						capabilityReason(capabilities, "releaseBooking", "drawer"),
					)
				) : null}
			</div>
		</div>
	);
}

/** The member drawer (mockup `open`, `openPerson`): who they are and what they see, the actions, the balance, the
 * upcoming bookings, the payments and the history. Pending writes show in it before the ledger ships them. */
export function MemberDrawer({
	context,
	school,
	unit,
	today,
	menuOpen,
	trapActive,
	busy,
	onMenu,
	onClose,
	onAction,
	onBookingAction,
}: DrawerProps): JSX.Element {
	const { person, member, detail, capabilities, viewer, changes } = context;
	const [showAll, setShowAll] = useState(false);
	const drawer = useRef<HTMLElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	useFocusTrap(trapActive, drawer, onClose);
	useEffect(() => closeButton.current?.focus(), []);
	const currency = school.currency;
	const owner = capabilities.role === "owner";
	const locked = viewer.preview;
	const standing = member ? standingOf(member, changes) : null;
	const reasons = attentionOf(person, standing?.canceled ?? false, changes);
	const balance = member?.balances[0];
	const projection = balance ? project(balance, person.id, changes) : null;
	const payments = paymentsOf(detail, person.id, changes, today);
	const history = historyOf(detail, person.id, changes);
	const hasFinance = person.role === "owner" || person.financeGrant;
	const moneyOf = (cents: number): JSX.Element | string =>
		viewer.finance ? formatMoney(cents, currency) : <FinanceOnly />;
	const expires = standing?.endsToday
		? "Today"
		: balance?.expiresAt
			? formatDay(balance.expiresAt, school.timeZone)
			: null;

	return (
		<aside
			ref={drawer}
			class="drawer on"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			data-test="member-drawer"
		>
			<button
				ref={closeButton}
				type="button"
				class="x"
				aria-label="Close"
				data-test="drawer-close"
				onClick={onClose}
			>
				×
			</button>
			<div class="mono mut" data-test="drawer-head">
				{person.id} · {school.name}
			</div>
			<h3 id={titleId} data-test="drawer-name" class="drawer-name">
				{person.name}
				{person.you && (
					<>
						{" "}
						<span class="mut" data-test="you-tag">
							(you)
						</span>
					</>
				)}
			</h3>
			<RoleChip role={person.role} />
			<FinanceChip person={person} />{" "}
			<span class="badge" data-test="member-plan">
				{member ? `${member.tierName} ×${member.quantity}` : "No plan"}
			</span>
			{member && (
				<>
					{" "}
					<AttentionBadges reasons={reasons} unitPlural={unit.other} />{" "}
					<span class="badge" data-test="renews-badge">
						renews {formatDay(member.currentPeriodEnd, school.timeZone)}
					</span>
				</>
			)}
			<div class="kcap">
				{person.role === "member" ? (
					<div data-test="capability-line" data-line="sees">
						Sees: only themselves and their family
					</div>
				) : (
					<>
						<div data-test="capability-line" data-line="sees">
							<b>Sees:</b> every member, dashboard, bookings
							{person.you ? " (you)" : ""}
						</div>
						<div data-test="capability-line" data-line="money">
							<b>Money:</b> {hasFinance ? "yes" : "no"}
							{person.role === "owner" ? " (owner)" : ""}
							{hasFinance ? " · refunds are owner only" : ""}
						</div>
					</>
				)}
				<div data-test="capability-line" data-line="audience">
					<b>Audience:</b> {audienceNames[person.audience]}{" "}
					<span class="mut">· {person.audienceReason}</span>
				</div>
			</div>
			<div class="acts">
				{member ? (
					<>
						<DrawerButton
							icon="eye"
							label="View as member"
							reason=""
							locked={false}
							tone="p"
							hook="drawer-action"
							action="view-as-member"
							onClick={() => onAction("view-as-member")}
						/>
						<DrawerButton
							icon="mail"
							label="Send invoice"
							reason={
								viewer.finance
									? capabilityReason(capabilities, "invoice", "drawer")
									: "Finance only"
							}
							locked={locked}
							hook="drawer-action"
							action="invoice"
							onClick={() => onAction("invoice")}
						/>
						<DrawerButton
							icon="sliders"
							label={`Adjust ${unit.other}`}
							reason={
								viewer.finance
									? capabilityReason(capabilities, "adjustCredits", "drawer")
									: "Finance only"
							}
							locked={locked}
							hook="drawer-action"
							action="adjust"
							onClick={() => onAction("adjust")}
						/>
						<DrawerButton
							icon="undo"
							label="Refund"
							reason={capabilityReason(capabilities, "refund", "drawer")}
							locked={locked}
							hook="drawer-action"
							action="refund"
							onClick={() => onAction("refund")}
						/>
					</>
				) : (
					<DrawerButton
						icon="eye"
						label="View as member"
						reason="No plan, so there is no member portal to view"
						locked={false}
						hook="drawer-action"
						action="view-as-member"
						onClick={() => onAction("view-as-member")}
					/>
				)}
				<MenuButton name="" expanded={menuOpen} onOpen={onMenu} />
			</div>
			{!owner && (
				<div class="mut drawer-note" data-test="drawer-note">
					{member ? "Refunds need" : "Changing roles needs"} the owner role in{" "}
					{school.name}.
				</div>
			)}
			{member && balance && projection && (
				<div class="line" data-test="drawer-balance">
					<b>{projection.reported}</b> available
					{projection.available !== projection.reported && (
						<>
							{" "}
							<span class="badge b-warn">
								<Icon name="clock" />→ {projection.available} after pending
							</span>
						</>
					)}{" "}
					of {balance.granted}
					{projection.held > 0 && (
						<>
							{" "}
							· <b>{projection.held}</b> held for bookings
						</>
					)}
					{expires !== null ? ` · expire ${expires}` : ""} · rollover 0
					<BalanceBar balance={balance} projection={projection} />
				</div>
			)}
			{detail.bookings.length > 0 && (
				<>
					<h5>
						<Icon name="clock" /> Upcoming bookings
					</h5>
					<div class="drawer-bookings">
						{detail.bookings.map((booking) => (
							<BookingRow
								key={booking.id}
								booking={booking}
								context={context}
								unit={unit}
								currency={currency}
								busy={busy}
								onAction={onBookingAction}
							/>
						))}
					</div>
				</>
			)}
			{member && (
				<div data-test="drawer-payments">
					<h5>
						<Icon name="coin" /> Payments{" "}
						<span class="mut payments-count">{payments.length} rows</span>{" "}
						<button
							type="button"
							class="link payments-csv"
							data-test="payments-csv"
							disabled={!viewer.finance}
							title={
								viewer.finance
									? "Download this member's payment history as CSV"
									: "Finance admins only"
							}
							onClick={() => onAction("csv")}
						>
							<Icon name="download" />
							Download CSV
						</button>
					</h5>
					<table class="kpay">
						<tbody>
							{(showAll ? payments : payments.slice(0, shortList)).map(
								(payment, index) => (
									<tr
										// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own (a refund on its way has none yet)
										key={index}
										data-test="payment-row"
									>
										<td class="mut">{formatPaymentDay(payment.date)}</td>
										<td>{payment.description}</td>
										<td
											class={
												payment.amountCents < 0 && viewer.finance
													? "r neg"
													: "r"
											}
										>
											{moneyOf(payment.amountCents)}
										</td>
										<td class="mut">{payment.status}</td>
									</tr>
								),
							)}
						</tbody>
					</table>
					{!showAll && payments.length > shortList && (
						<button
							type="button"
							class="link"
							data-test="payments-all"
							onClick={() => setShowAll(true)}
						>
							Show all payments ({payments.length})
						</button>
					)}
				</div>
			)}
			<h5>
				<Icon name="list" /> History
			</h5>
			<ul class="tl" data-test="drawer-history">
				{history.length === 0 && (
					<li class="mut quiet" data-test="history-empty">
						No activity yet.
					</li>
				)}
				{(showAll ? history : history.slice(0, shortList)).map(
					({ event, pending }, index) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: events have no id of their own (one on its way has none yet)
							key={index}
							class={pending ? "pd" : undefined}
							style={{
								"--c": eventColors[event.type] ?? "var(--muted-foreground)",
							}}
							data-test="history-item"
							data-pending={pending ? "true" : undefined}
						>
							<b>{eventLabel(event, unit)}</b>{" "}
							{event.credits !== null ? (
								signed(event.credits, String(Math.abs(event.credits)))
							) : event.amountCents !== null ? (
								viewer.finance ? (
									amountText(event.amountCents)
								) : (
									<FinanceOnly />
								)
							) : (
								""
							)}{" "}
							{event.text}
							{event.bookingId !== null && (
								<>
									{" "}
									<span class="mono mut">{event.bookingId}</span>
								</>
							)}
							{event.promo !== null && (
								<>
									{" "}
									<span class="mono mut">promo {event.promo}</span>
								</>
							)}
							<div class="t">
								{pending
									? "just now · you · ships within 5 min"
									: `${monthAndDay(event.at.slice(0, 10))} · ${event.source}`}
							</div>
						</li>
					),
				)}
				{!showAll && history.length > shortList && (
					<li class="quiet">
						<button type="button" class="link" onClick={() => setShowAll(true)}>
							Show all ({history.length})
						</button>
					</li>
				)}
			</ul>
		</aside>
	);
}
