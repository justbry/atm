import { Fragment, type JSX } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import {
	audienceNames,
	type CreditUnit,
	csvFileNames,
	drillLabels,
	type LedgerDrill,
	type LedgerEntry,
	type LedgerTypeFilter,
	ledgerColumns,
	ledgerLabel,
	maskCode,
	needsPin,
	seesIdentities,
} from "../data/ledger.ts";
import { type BooksPaneProps, identitiesLockHeading } from "./books-pane.ts";
import { DownloadButton } from "./download-button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { LoadFailed } from "./load-failed.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { formatMoney, signedCount } from "./money.ts";
import { monthAndDay, parsePeriod, weekdayName } from "./period.ts";
import { PinLock } from "./pin-lock.tsx";
import { withQuery } from "./route.ts";
import { useLoaded } from "./use-loaded.ts";
import { useViewing } from "./viewing.ts";
import { capitalise, plural } from "./wording.ts";

/** The mockup's bkBlocked admin branch: an admin without the finance grant still has Members. */
const adminBooksSentence =
	"Admins without the finance grant see the roster, balances and bookings in Members.";

const typeChips: Array<{
	slug: string;
	type: LedgerTypeFilter | null;
	label: string | null;
	icon: IconName | null;
}> = [
	{ slug: "all", type: null, label: "All", icon: null },
	{ slug: "payment", type: "payment", label: "Payments", icon: "coin" },
	{ slug: "credit", type: "credit", label: null, icon: "ticket" },
	{ slug: "booking", type: "booking", label: "Bookings", icon: "clock" },
	{ slug: "code", type: "code", label: "Promos", icon: "tag" },
	{ slug: "payout", type: "payout", label: "Payouts", icon: "bank" },
	{ slug: "admin", type: "admin", label: "Admin actions", icon: "user" },
];

/** The mockup's `C` and `evIcon`: the colour and the icon of an event's badge. */
const eventColors: Record<string, string> = {
	"credit.granted": "var(--success)",
	"credit.spent": "var(--chart-1)",
	"credit.held": "var(--chart-3,var(--warning))",
	"credit.released": "var(--muted-foreground)",
	"credit.forfeited": "var(--destructive)",
	"credit.depleted": "var(--destructive)",
	"credit.refunded": "var(--warning)",
	"credit.adjusted": "var(--chart-5,var(--primary))",
	"payment.succeeded": "var(--info)",
	"payment.refunded": "var(--warning)",
};
const eventIcons: Record<string, IconName> = {
	"payment.refunded": "undo",
	"payout.paid": "bank",
	"credit.granted": "plus",
	"credit.spent": "check",
	"credit.held": "clock",
	"credit.released": "unlock",
	"credit.forfeited": "ban",
	"credit.depleted": "alert",
	"credit.refunded": "undo",
	"credit.expired": "clock",
	"credit.adjusted": "sliders",
	"catalog.published": "layers",
};
function eventIcon({ event }: LedgerEntry): IconName {
	if (event.event_type !== "payment.succeeded")
		return eventIcons[event.event_type] ?? "dot";
	if (event.labels.kind === "booking") return "ticket";
	return event.labels.kind === "gift" ? "gift" : "coin";
}

const isDrill = (value: string | null): value is LedgerDrill =>
	value !== null && value in drillLabels;
const columnCount = 6;

/** The Amount column: two decimals, signed, no currency; a payout is shown without a sign (mockup `usd`). */
function entryAmount({ event, amountCents }: LedgerEntry): string {
	if (amountCents === null) return "";
	const text = (Math.abs(amountCents) / 100).toFixed(2);
	if (event.event_type === "payout.paid") return text;
	return `${amountCents < 0 ? "−" : "+"}${text}`;
}

function EntryRows({
	entry,
	unit,
	open,
	onToggle,
}: {
	entry: LedgerEntry;
	unit: CreditUnit;
	open: boolean;
	onToggle: () => void;
}): JSX.Element {
	const { event, member, promo } = entry;
	const { booking } = event.labels;
	return (
		<>
			<tr
				class={entry.pending ? "row pend" : "row"}
				data-test="ledger-row"
				data-event={event.id}
				onClick={onToggle}
			>
				<td class="mono" data-test="ledger-time">
					{entry.pending ? "just now" : entry.localTime.slice(11)}
				</td>
				<td data-test="ledger-event">
					<span
						class="badge"
						style={{
							borderColor: eventColors[event.event_type] ?? "var(--border)",
						}}
					>
						<Icon name={eventIcon(entry)} />
						{ledgerLabel(entry, unit)}
					</span>
					{entry.pending && (
						<>
							{" "}
							<span class="badge b-warn">pending</span>
						</>
					)}
				</td>
				<td data-test="ledger-member">
					{member ? (
						<>
							<b>{member.name}</b> <span class="mono mut">{member.id}</span>
						</>
					) : (
						<span class="mono">—</span>
					)}
				</td>
				<td data-test="ledger-what">
					{event.text}{" "}
					{booking && <span class="mono mut">{`· ${booking}`}</span>}
					{promo && (
						<>
							{" "}
							<span class="mono mut">{`· promo ${maskCode(promo.code)}`}</span>
						</>
					)}{" "}
					<span class="mono mut">{`· ${event.source}`}</span>{" "}
					<button type="button" class="link" aria-expanded={open}>
						Details
					</button>
				</td>
				<td class="r" data-test="ledger-credits">
					{signedCount(entry.credits ?? 0)}
				</td>
				<td
					class={
						entry.amountCents !== null && entry.amountCents < 0 ? "r neg" : "r"
					}
					data-test="ledger-amount"
				>
					{entryAmount(entry)}
				</td>
			</tr>
			{open && (
				<tr class="dt" data-test="ledger-details">
					<td colSpan={columnCount}>
						<span class="mono">{event.event_type}</span>
						{" · "}
						<span class="mono">{`source ${event.source}`}</span>
						<br />
						<span class="mono">
							{JSON.stringify({
								id: event.id,
								event_type: event.event_type,
								key: event.key,
								labels: event.labels,
								postings: event.postings,
							})}
						</span>
					</td>
				</tr>
			)}
		</>
	);
}

/** The Ledger tab (mockup `ledger()`): atm's events for the period, newest day first, filtered by type, Reports
 * drill-down or promo. Finance admins and the owner only: any other audience gets the lock panel and no read. */
export function Ledger({
	reader,
	writer,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
}: BooksPaneProps): JSX.Element | null {
	const { query } = route;
	const { audience, value: viewedAs } = useViewing().option;
	const pinLocked = query.get("pin") === "locked" && needsPin(audience);
	const readable = seesIdentities(audience) && !pinLocked;
	const period = parsePeriod(query.get("month"), clock.today);
	const typeAsked = query.get("type");
	const type =
		typeChips.find((chip) => chip.type !== null && chip.type === typeAsked)
			?.type ?? null;
	const drillAsked = query.get("drill");
	const drill = isDrill(drillAsked) ? drillAsked : null;
	const promo = query.get("promo");
	const key = [school.id, period.from, period.to, type, drill, promo, readable]
		.map(String)
		.join("|");
	const [loaded, , status] = useLoaded(key, async () => {
		if (!readable) return null;
		const [page, promos] = await Promise.all([
			reader.ledger({
				school: school.id,
				from: period.from,
				to: period.to,
				type,
				drill,
				promo,
			}),
			promo === null
				? Promise.resolve(null)
				: reader.promos({ school: school.id, audience }),
		]);
		return {
			page,
			promoCode: promos?.promos.find(({ id }) => id === promo)?.code ?? null,
		};
	});
	const [opened, setOpened] = useState<string[]>([]);
	useLayoutEffect(() => {
		if (!readable || loaded !== null || status.failed) onRendered();
	});

	if (pinLocked)
		return (
			<PinLock
				key={audience}
				levelName={audienceNames[audience]}
				onUnlock={() => {
					navigate(withQuery(route, "pin", null));
					onToast("Books unlocked for this session.");
				}}
			/>
		);
	if (!readable)
		return (
			<LockPanel
				lock={{
					reason: "no_grant",
					who: identitiesLockHeading,
					when: `This lists who paid what: one row per person with amounts, refunds and member ids. ${viewedAs === "admin" ? adminBooksSentence : `${audienceNames[audience]} sees totals in Reports and the Dashboard.`} Every identified read is audited.`,
				}}
				hooks="books"
			/>
		);
	if (status.failed)
		return <LoadFailed what="the ledger" onRetry={status.retry} />;
	if (!loaded) return null;

	const { page, promoCode } = loaded;
	// The page names them from the latest published menu; a school with none answers null, so the school's own
	// settings name them instead.
	const unit = page.unit ?? school.creditUnit;
	const timeZone = page.timeZone ?? school.timeZone;
	const currency = page.currency ?? school.currency;
	const entries = [...page.pending, ...page.days.flatMap((day) => day.entries)];
	const clearFilters = (): void =>
		navigate(withQuery(withQuery(route, "drill", null), "promo", null));
	const toggle = (id: string): void =>
		setOpened(
			opened.includes(id)
				? opened.filter((other) => other !== id)
				: [...opened, id],
		);
	const rowsOf = (list: LedgerEntry[]): JSX.Element[] =>
		list.map((entry) => (
			<EntryRows
				key={entry.event.id}
				entry={entry}
				unit={unit}
				open={opened.includes(entry.event.id)}
				onToggle={() => toggle(entry.event.id)}
			/>
		));

	return (
		<>
			<div class="tools">
				{typeChips.map((chip) => {
					const on = chip.type === type;
					return (
						<button
							key={chip.slug}
							type="button"
							class={on ? "chip f on" : "chip f"}
							aria-pressed={on}
							data-test="ledger-type"
							data-type={chip.slug}
							onClick={() => navigate(withQuery(route, "type", chip.type))}
						>
							{chip.icon && <Icon name={chip.icon} />}
							{chip.label ?? capitalise(unit.other)}
						</button>
					);
				})}
				{drill && (
					<button
						type="button"
						class="chip on"
						data-test="ledger-filter"
						onClick={clearFilters}
					>
						{`Filter: ${drillLabels[drill]} ×`}
					</button>
				)}
				{promo && (
					<button
						type="button"
						class="chip on"
						data-test="ledger-filter"
						onClick={clearFilters}
					>
						{`Promo ${maskCode(promoCode ?? promo)} ×`}
					</button>
				)}
				<span class="sp" />
				<span class="mut" data-test="ledger-count">
					{`${plural(page.count, "event")} · ${timeZone}`}
				</span>
				<DownloadButton
					writer={writer}
					onToast={onToast}
					test="ledger-csv"
					className="link"
					title="Download the rows in this view as CSV"
					label="Download CSV"
					name={csvFileNames.ledger(page.from, page.to)}
					columns={ledgerColumns(currency)}
					rows={entries}
				/>
			</div>
			<table>
				<thead>
					<tr>
						<th style="width:70px">Time</th>
						<th>Event</th>
						<th>Member</th>
						<th>What happened</th>
						<th class="r" data-test="ledger-credit-head">
							{capitalise(unit.other)}
						</th>
						<th class="r">Amount</th>
					</tr>
				</thead>
				<tbody>
					{page.pending.length > 0 && (
						<>
							<tr class="day wait" data-test="ledger-pending">
								<td colSpan={columnCount}>
									<Icon name="clock" />
									{` Waiting to ship (${page.pending.length}) · each ships within 5 min`}
								</td>
							</tr>
							{rowsOf(page.pending)}
						</>
					)}
					{page.days.map((day) => (
						<Fragment key={day.date}>
							<tr class="day" data-test="ledger-day" data-day={day.date}>
								<td colSpan={4} data-test="ledger-day-label">
									{`${weekdayName(day.date)} ${monthAndDay(day.date)} · ${plural(day.count, "event")}`}
								</td>
								<td class="r" data-test="ledger-day-credits">
									{signedCount(day.credits)}
								</td>
								<td class="r" data-test="ledger-day-amount">
									{day.amountCents === 0
										? ""
										: formatMoney(day.amountCents, currency)}
								</td>
							</tr>
							{rowsOf(day.entries)}
						</Fragment>
					))}
				</tbody>
			</table>
			{page.count === 0 && (
				<p
					class="mut"
					data-test="ledger-empty"
					style="text-align:center;padding:24px 0"
				>
					No events in this period.
				</p>
			)}
		</>
	);
}
