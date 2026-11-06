import { Fragment, type JSX } from "preact";
import { audienceNames } from "../data/disclosure.ts";
import type { DocumentPeriod, KpiDocument } from "../data/kpi-document.ts";
import {
	type FamilyRole,
	type HistoryPeriod,
	historyPeriods,
	historyRowsIn,
	historyShortRows,
	type MemberPortal,
	type PortalAudience,
	type PortalBalance,
	type PortalBooking,
	type PortalHistoryRow,
	type PortalMember,
	paymentStatusLabels,
} from "../data/portal.ts";
import type { Clock, School } from "../data/types.ts";
import { cutoffHours } from "./booking-text.ts";
import { Icon, type IconName } from "./icon.tsx";
import { KpiValue } from "./kpi-cell.tsx";
import { formatMoney } from "./money.ts";
import { monthAndDay, monthAndYear, monthName } from "./period.ts";
import { count, type Plan } from "./portal-format.ts";

const previewTitle = "Exit preview to act";
const minutesPerMillisecond = 1 / 60_000;
const percentScale = 100;

/** The Overview, Bookings, Billing and Family tabs of the member's view (mockup `mpHome`, `mpBk`, `mpBill`, `mpFam`). */
export type PortalTab = "overview" | "bookings" | "billing" | "family";

type ButtonProps = {
	action: string;
	icon?: IconName;
	label: string;
	tone?: "p" | "d";
	/** Why the button is off, shown as its title; a preview of another audience turns every write button off. */
	reason?: string | undefined;
	preview: boolean;
	attributes?: Record<string, string>;
	onClick: () => void;
};

/** A write or hand-off button of the member's view (mockup `data-vact`, `data-act`). */
function ActionButton({
	action,
	icon,
	label,
	tone,
	reason,
	preview,
	attributes,
	onClick,
}: ButtonProps): JSX.Element {
	const title = preview ? previewTitle : reason;
	return (
		<button
			type="button"
			class={tone ? `mp-btn ${tone}` : "mp-btn"}
			data-test="portal-action"
			data-action={action}
			disabled={preview || Boolean(reason)}
			title={title}
			{...attributes}
			onClick={onClick}
		>
			{icon && <Icon name={icon} />}
			{label}
		</button>
	);
}

type Handlers = {
	onQuantity: () => void;
	onCancel: () => void;
	onResume: () => void;
	onCard: () => void;
	onBuy: (addonId: string) => void;
	onBooks: (toast: string) => void;
	onCancelBooking: (booking: PortalBooking) => void;
};

type ViewProps = {
	school: School;
	clock: Clock;
	portal: MemberPortal;
	viewed: PortalMember;
	plan: Plan;
	preview: boolean;
	pendingBookings: ReadonlySet<string>;
	handlers: Handlers;
};

/** The bar of used, held and available side by side (mockup `mpBar`). */
function Bar({ balance }: { balance: PortalBalance }): JSX.Element {
	const total = Math.max(balance.used + balance.held + balance.available, 1);
	const width = (value: number): string =>
		`${((value / total) * percentScale).toFixed(1)}%`;
	return (
		<div
			class="mp-bar"
			role="img"
			aria-label={`used ${balance.used}, held ${balance.held}, available ${balance.available}`}
		>
			<i class="u" style={`width:${width(balance.used)}`} />
			<i class="h" style={`width:${width(balance.held)}`} />
			<i class="a" style={`width:${width(balance.available)}`} />
		</div>
	);
}

function PlanCard({
	school,
	viewed,
	plan,
	preview,
	handlers,
}: ViewProps): JSX.Element {
	const quantityReason = (() => {
		if (!viewed.quantityOptions) return "This plan is sold in one size";
		if (plan.ended) return "Resume your membership first";
		return plan.waiting ? "A change is already on its way" : undefined;
	})();
	return (
		<div class="mp-card" data-test="portal-plan">
			<div class="mp-row">
				<div>
					<h4 data-test="portal-plan-name">{plan.label}</h4>
					<div class="mp-muted" data-test="portal-plan-price">
						{formatMoney(plan.priceCents, school.currency)} / {viewed.interval}
					</div>
				</div>
				<span
					class={plan.ended ? "mp-pill w" : "mp-pill"}
					data-test="portal-plan-status"
				>
					{plan.ended ? `Ends ${plan.endsOn}` : "Active"}
				</span>
			</div>
			<div class="mp-muted" style="margin-top:8px" data-test="portal-plan-line">
				{plan.ended
					? `Your membership ends on ${plan.endsOn}. You can keep using your ${school.creditUnit.other} until then.`
					: `Renews ${plan.endsOn} · next invoice ${formatMoney(plan.priceCents, school.currency)}`}
			</div>
			{plan.scheduled && (
				<div class="mp-note" data-test="portal-plan-note">
					<Icon name="clock" /> Switches to {plan.scheduled} on {plan.endsOn}.
				</div>
			)}
			{plan.waiting && (
				<div class="mp-note" data-test="portal-plan-note">
					<Icon name="clock" /> A change is on its way. It can take a few
					minutes.
				</div>
			)}
			<div class="mp-acts">
				<ActionButton
					action="quantity"
					icon="sliders"
					label="Change amount"
					reason={quantityReason}
					preview={preview}
					onClick={handlers.onQuantity}
				/>
				{plan.ended ? (
					<ActionButton
						action="resume"
						icon="undo"
						label="Resume membership"
						tone="p"
						reason={plan.waiting ? "A change is already on its way" : undefined}
						preview={preview}
						onClick={handlers.onResume}
					/>
				) : (
					<ActionButton
						action="cancel"
						icon="ban"
						label="Cancel membership"
						tone="d"
						reason={plan.waiting ? "A change is already on its way" : undefined}
						preview={preview}
						onClick={handlers.onCancel}
					/>
				)}
			</div>
		</div>
	);
}

function BalanceCard({
	balance,
	plan,
}: {
	balance: PortalBalance;
	plan: Plan;
}): JSX.Element {
	return (
		<div class="mp-card" data-test="portal-balance">
			<div class="mp-row">
				<div>
					<div class="mp-big" data-test="portal-available">
						{balance.available}
					</div>
					<div class="mp-muted">{balance.unit.other} available</div>
				</div>
				<div class="mp-muted" style="text-align:right">
					{balance.held > 0 && (
						<>
							{balance.held} held for bookings
							<br />
						</>
					)}
					{balance.used} used this cycle
				</div>
			</div>
			<Bar balance={balance} />
			{!plan.ended && (
				<div class="mp-muted" style="margin-top:8px">
					Your allowance refreshes on {plan.endsOn}.
				</div>
			)}
		</div>
	);
}

/** What the School books card says about each audience. The document's own policy is not in the Reader yet (S7's
 * `Disclosure`), so these lines are the mockup's. */
const booksCopy: Record<PortalAudience, string> = {
	public:
		"Public document: years, money rounded to $100, published 12 months after a year closes. Totals and categories only.",
	member:
		"Member document: Quarters, 6 weeks after each closes, money rounded to $100, totals and categories only.",
	governance:
		"Governance document: months, exact, with plan and fund breakdowns and how gifts spread. No names or per-person rows.",
	finance:
		"Finance admin: everything in the admin dashboard, names included. Opened with your PIN.",
	owner:
		"Owner: everything in the admin dashboard, names included. Opened with your PIN.",
};
const booksActions: Partial<
	Record<PortalAudience, { label: string; icon: IconName; toast: string }>
> = {
	member: {
		label: "Open school books",
		icon: "scale",
		toast: "Opening the school's books…",
	},
	governance: {
		label: "Open the governance view",
		icon: "users",
		toast: "Opening the governance view of the school's books…",
	},
};

/** The newest period the document shows its money for. */
export const publishedPeriod = (
	document: KpiDocument,
): DocumentPeriod | undefined =>
	document.periods.filter(({ state }) => state === "shown").at(-1);

/** `5 Nov 2026`. */
const dayMonthYear = (date: string): string =>
	`${Number(date.slice(8))} ${monthName(date)} ${date.slice(0, 4)}`;

function BooksCard({
	portal,
	figures,
	handlers,
	changedOn,
}: {
	portal: MemberPortal;
	figures: KpiDocument | null;
	handlers: Handlers;
	/** The day a publish gave this member's tier another audience. */
	changedOn: string | null;
}): JSX.Element {
	const { audience, guardian } = portal.books;
	const action = guardian ? undefined : booksActions[audience];
	const shown = figures ? publishedPeriod(figures) : undefined;
	let figuresLine: JSX.Element | string | null = null;
	if (figures && shown) {
		const cell = (kpi: string): JSX.Element => (
			<KpiValue
				document={figures}
				grain={figures.grain}
				kpi={kpi}
				period={shown.period}
			/>
		);
		figuresLine = (
			<>
				{" "}
				{shown.label}: {cell("gross_collected")} collected, {cell("net_income")}{" "}
				net.
			</>
		);
	} else if (figures) figuresLine = " Nothing is published yet.";
	return (
		<div class="mp-card" data-test="books-card" data-audience={audience}>
			<div class="mp-row">
				<div>
					<h4>
						<Icon name="scale" /> School books
					</h4>
					{changedOn && !guardian && (
						<div class="mp-note" data-audchg>
							<Icon name="info" /> What members can see changed on{" "}
							{dayMonthYear(changedOn)}.
						</div>
					)}
					<div class="mp-muted" data-test="books-text">
						{guardian
							? `Your guardian (${guardian.name}) sees school books. A child never holds a member or governance audience; the adult on the account does.`
							: booksCopy[audience]}
						{figuresLine}
					</div>
				</div>
				<span class="mp-pill" data-test="books-pill">
					{guardian ? "Via guardian" : audienceNames[audience]}
				</span>
			</div>
			{action && (
				<div class="mp-acts">
					<button
						type="button"
						class="mp-btn"
						data-test="portal-action"
						data-action="books"
						onClick={() => handlers.onBooks(action.toast)}
					>
						<Icon name={action.icon} />
						{action.label}
					</button>
				</div>
			)}
		</div>
	);
}

export function Overview(
	props: ViewProps & {
		figures: KpiDocument | null;
		audienceChangedOn: string | null;
	},
): JSX.Element {
	const {
		portal,
		viewed,
		plan,
		school,
		preview,
		handlers,
		figures,
		audienceChangedOn,
	} = props;
	return (
		<>
			<PlanCard {...props} />
			{viewed.balances.map((balance) => (
				<BalanceCard key={balance.featureId} balance={balance} plan={plan} />
			))}
			<BooksCard
				portal={portal}
				figures={figures}
				handlers={handlers}
				changedOn={audienceChangedOn}
			/>
			{portal.addons.length > 0 && (
				<div class="mp-card" data-test="portal-addons">
					<h4 style="margin-bottom:8px">
						Need more {school.creditUnit.other}?
					</h4>
					<div class="mp-list">
						{portal.addons.map((addon) => (
							<div class="mp-item" key={addon.id}>
								<div>
									<b>{addon.name}</b>
									<div class="mp-muted">
										{count(addon.grants, school.creditUnit)} ·{" "}
										{formatMoney(addon.priceCents, school.currency)}
									</div>
								</div>
								<ActionButton
									action="buy"
									label="Buy"
									preview={preview}
									attributes={{ "data-addon": addon.id }}
									onClick={() => handlers.onBuy(addon.id)}
								/>
							</div>
						))}
					</div>
				</div>
			)}
		</>
	);
}

/** The bookings of one person, soonest first (the document lists them that way). */
export const bookingsOf = (
	portal: MemberPortal,
	profileId: string,
): PortalBooking[] =>
	portal.bookings.filter((booking) => booking.profileId === profileId);

const minutesUntil = (now: string, wallTime: string): number =>
	(Date.parse(`${wallTime}:00Z`) - Date.parse(`${now}:00Z`)) *
	minutesPerMillisecond;

/** The line under a booking: what it holds or cost, and whether it can still be cancelled free (mockup `mpBk`). */
function bookingTail(booking: PortalBooking, clock: Clock, school: School) {
	const cost =
		booking.paidCents === null
			? booking.held > 0
				? `${count(booking.held, school.creditUnit)} held`
				: "Free"
			: `Paid ${formatMoney(booking.paidCents, school.currency)}`;
	const started = booking.startsAt < clock.now;
	if (started || booking.state === "requested") return cost;
	const cutoff = cutoffHours(booking.cutoffMinutes);
	return minutesUntil(clock.now, booking.startsAt) < booking.cutoffMinutes
		? `${cost} · inside the ${cutoff} cutoff`
		: `${cost} · free to cancel until ${cutoff} before`;
}

function BookingStatus({
	booking,
	waiting,
	clock,
	preview,
	onCancel,
}: {
	booking: PortalBooking;
	waiting: boolean;
	clock: Clock;
	preview: boolean;
	onCancel: () => void;
}): JSX.Element {
	if (waiting)
		return (
			<span class="mp-pill w" data-test="portal-booking-status">
				<Icon name="clock" />
				waiting to ship
			</span>
		);
	if (booking.state === "requested")
		return (
			<span class="mp-pill n" data-test="portal-booking-status">
				Waiting for approval
			</span>
		);
	if (booking.startsAt < clock.now)
		return (
			<span class="mp-pill n" data-test="portal-booking-status">
				Awaiting confirmation
			</span>
		);
	if (booking.paidCents !== null)
		return (
			<span class="mp-muted" data-test="portal-booking-status">
				Contact the school to cancel
			</span>
		);
	return (
		<ActionButton
			action="cancel-booking"
			label="Cancel booking"
			preview={preview}
			attributes={{ "data-booking": booking.id }}
			onClick={onCancel}
		/>
	);
}

const hostNames = (booking: PortalBooking): string =>
	booking.hosts.map(({ name }) => name).join(", ");
const whenOf = (booking: PortalBooking): string =>
	`${monthAndDay(booking.startsAt.slice(0, 10))} ${booking.startsAt.slice(11)}`;

export function BookingsTab({
	portal,
	viewed,
	school,
	clock,
	preview,
	pendingBookings,
	handlers,
}: ViewProps): JSX.Element {
	const bookings = bookingsOf(portal, viewed.profileId);
	if (bookings.length === 0)
		return (
			<div class="mp-card mp-muted" data-test="portal-empty">
				No upcoming bookings.
			</div>
		);
	return (
		<div class="mp-card">
			<div class="mp-list">
				{bookings.map((booking) => (
					<div
						class="mp-item mp-bk"
						key={booking.id}
						data-test="portal-booking"
						data-booking={booking.id}
					>
						<div>
							<b data-test="portal-booking-service">{booking.service}</b>
							<div class="mp-muted">
								{whenOf(booking)} · {hostNames(booking)}
							</div>
							<div class="mp-muted">{bookingTail(booking, clock, school)}</div>
						</div>
						<div class="mp-acts" style="margin:0">
							<BookingStatus
								booking={booking}
								waiting={pendingBookings.has(booking.id)}
								clock={clock}
								preview={preview}
								onCancel={() => handlers.onCancelBooking(booking)}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

const roleLabels: Record<FamilyRole, string> = {
	adult: "Adult",
	teen: "Teen",
	child: "Child",
};
export const familyRoleLabel = (role: FamilyRole): string => roleLabels[role];

export function FamilyTab({ portal, viewed, school }: ViewProps): JSX.Element {
	const unit = school.creditUnit;
	if (!portal.family)
		return (
			<div class="mp-card mp-muted" data-test="portal-empty">
				No family on this account. You see only your own {unit.other} and
				bookings.
			</div>
		);
	return (
		<div class="mp-fam">
			<div class="mp-muted" data-test="portal-family-note">
				{portal.scope === "family"
					? `${portal.family.label}: as the adult you see everyone's ${unit.other} and bookings.`
					: `You see only your own ${unit.other} and bookings. The adult on the account sees the rest of the family.`}
			</div>
			{portal.people.map((person) => {
				const bookings = bookingsOf(portal, person.profileId);
				return (
					<div
						class="mp-card mp-fm"
						key={person.profileId}
						data-test="portal-family-card"
						data-profile={person.profileId}
					>
						<div class="mp-row">
							<div>
								<h4>
									{person.name}
									{person.profileId === viewed.profileId ? " (you)" : ""}
								</h4>
								<div class="mp-muted">
									{person.familyRole ? roleLabels[person.familyRole] : ""} ·{" "}
									{person.tierName} ×{person.quantity}
								</div>
							</div>
							{person.balances.map((balance) => (
								<div style="text-align:right" key={balance.featureId}>
									<div
										class="mp-big"
										style="font-size:20px"
										data-test="portal-available"
									>
										{balance.available}
									</div>
									<div class="mp-muted">{balance.unit.other} available</div>
								</div>
							))}
						</div>
						{person.balances.map((balance) => (
							<Bar key={balance.featureId} balance={balance} />
						))}
						<div class="mp-muted" style="margin-top:8px">
							{bookings.length === 0
								? "No upcoming bookings."
								: bookings.map((booking, index) => (
										<Fragment key={booking.id}>
											{index > 0 && <br />}
											{booking.service} · {whenOf(booking)}
											{booking.held > 0
												? ` · ${count(booking.held, unit)} held`
												: ""}
										</Fragment>
									))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

const pillTone = (status: PortalHistoryRow["status"]): string => {
	if (status === "paid") return "mp-pill";
	return status === "failed" ? "mp-pill w" : "mp-pill n";
};
/** `Nov 3, 2026`. */
const dayText = (date: string): string =>
	`${monthAndDay(date)}, ${date.slice(0, 4)}`;

export type HistoryControls = {
	/** Money per person is for the owner and finance admins: another admin's preview shows no amounts and cannot
	 * export. */
	finance: boolean;
	period: HistoryPeriod;
	expanded: boolean;
	onPeriod: (period: HistoryPeriod) => void;
	onExpand: () => void;
	onDownload: (rows: PortalHistoryRow[]) => void;
};

function HistoryCard({
	portal,
	clock,
	controls,
}: Pick<ViewProps, "portal" | "clock"> & {
	controls: HistoryControls;
}): JSX.Element {
	const selected = historyRowsIn(portal.history, controls.period, clock);
	const shown = controls.expanded
		? selected
		: selected.slice(0, historyShortRows);
	const family = portal.scope === "family";
	const nameOf = (profileId: string): string =>
		portal.people.find((person) => person.profileId === profileId)?.name ?? "";
	const body: JSX.Element[] = [];
	let group = "";
	for (const row of shown) {
		const heading = monthAndYear(row.date);
		if (heading !== group) {
			group = heading;
			body.push(
				<tr class="grp" key={heading}>
					<th colSpan={4} scope="colgroup" data-test="history-group">
						{heading}
					</th>
				</tr>,
			);
		}
		body.push(
			<tr
				class="k-r"
				key={`${row.profileId}-${row.invoiceId}-${row.paymentId}-${row.amountCents}`}
				data-test="history-row"
				data-profile={row.profileId}
			>
				<td class="khd" data-test="history-date">
					{dayText(row.date)}
				</td>
				<td class="kht">
					<span data-test="history-description">{row.description}</span>
					{row.refundPending && (
						<>
							{" "}
							<span class="mp-pill w">refund pending</span>
						</>
					)}
					{family && (
						<div class="mp-muted" data-test="history-member">
							{nameOf(row.profileId)}
						</div>
					)}
				</td>
				<td
					class={
						row.amountCents < 0 && controls.finance ? "r kha neg2" : "r kha"
					}
					data-test="history-amount"
				>
					{controls.finance ? (
						formatMoney(row.amountCents, row.currency)
					) : (
						<span
							class="khid"
							data-hid="no_grant"
							title="Finance admins and the owner see money per person; the member sees their own"
						>
							Finance only
						</span>
					)}
				</td>
				<td class="khs">
					<span class={pillTone(row.status)} data-test="history-status">
						{paymentStatusLabels[row.status]}
					</span>
				</td>
			</tr>,
		);
	}
	return (
		<div class="mp-card" data-test="history-card">
			<div class="mp-row kh-head">
				<div>
					<h4>Invoices and payments</h4>
					<div class="mp-muted" data-test="history-count">
						{selected.length > 0
							? `Showing ${shown.length} of ${selected.length}, newest first`
							: "Nothing in this period"}
					</div>
				</div>
				<div class="mp-acts">
					<select
						class="mp-sel"
						aria-label="History period"
						data-test="history-period"
						value={controls.period}
						onInput={(event) =>
							controls.onPeriod(event.currentTarget.value as HistoryPeriod)
						}
					>
						{historyPeriods.map(({ id, label }) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
					<button
						type="button"
						class="mp-btn"
						data-test="history-download"
						title={
							controls.finance
								? "Download this history as CSV"
								: "Finance admins only"
						}
						disabled={!controls.finance || selected.length === 0}
						onClick={() => controls.onDownload(selected)}
					>
						<Icon name="download" />
						Download CSV
					</button>
				</div>
			</div>
			{selected.length > 0 ? (
				<>
					<table class="mpt k">
						<thead>
							<tr>
								<th>Date</th>
								<th>Description</th>
								<th class="r">Amount</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>{body}</tbody>
					</table>
					{selected.length > historyShortRows && (
						<div class="kh-more">
							<button
								type="button"
								class="mp-btn"
								data-test="history-more"
								aria-expanded={controls.expanded}
								onClick={controls.onExpand}
							>
								{controls.expanded
									? `Show latest ${historyShortRows}`
									: `Show all history (${selected.length})`}
							</button>
						</div>
					)}
				</>
			) : (
				<div class="mp-muted" style="margin-top:8px">
					No invoices or payments in this period.
				</div>
			)}
		</div>
	);
}

export function BillingTab(
	props: ViewProps & { controls: HistoryControls },
): JSX.Element {
	const { school, plan, preview, handlers, controls } = props;
	return (
		<>
			<div class="mp-card" data-test="portal-next-invoice">
				<div class="mp-row">
					<div>
						<h4>Next invoice</h4>
						<div class="mp-muted">
							{plan.ended
								? `None. Your membership ends ${plan.endsOn}.`
								: `${plan.endsOn} · ${formatMoney(plan.priceCents, school.currency)}`}
						</div>
					</div>
				</div>
			</div>
			<div class="mp-card" data-test="portal-payment-method">
				<div class="mp-row">
					<div>
						<h4>Payment method</h4>
						<div class="mp-muted">Card details stay with Stripe.</div>
					</div>
					<ActionButton
						action="card"
						icon="card"
						label="Update"
						preview={preview}
						onClick={handlers.onCard}
					/>
				</div>
			</div>
			<HistoryCard
				portal={props.portal}
				clock={props.clock}
				controls={controls}
			/>
		</>
	);
}
