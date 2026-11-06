import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
	csvFileNames,
	type HistoryCsvRow,
	historyColumns,
} from "../data/ledger.ts";
import {
	type Capabilities,
	financeOnly,
	type InvoiceItem,
	type Member,
	type MemberBooking,
	type MemberDetail,
	type MembersReader,
	type MembersSummary,
	type MembersWriter,
	type Person,
	type SwitchTier,
} from "../data/members.ts";
import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { endSentence, failedToast, reminderToast } from "./booking-text.ts";
import { saveFile } from "./download.ts";
import { saveCsv } from "./download-button.tsx";
import { Icon } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { type BookingAction, MemberDrawer } from "./member-drawer.tsx";
import {
	MemberMenu,
	type MenuAction,
	MenuButton,
	type PersonContext,
	roleActions,
} from "./member-menu.tsx";
import {
	type Action,
	ActionModal,
	type ModalContext,
} from "./member-modals.tsx";
import {
	AttentionBadges,
	AudienceChip,
	BalanceBar,
	FinanceChip,
	RoleChip,
} from "./member-parts.tsx";
import {
	type Applied,
	applyRoles,
	attentionOf,
	attentionScore,
	type Change,
	capitalized,
	formatDay,
	insideCutoffOf,
	paymentsOf,
	project,
	roleLabels,
	roleRank,
	rosterLock,
	type Standing,
	standingOf,
	viewerOf,
} from "./members-model.ts";
import {
	recordOutcome,
	releaseHold,
	type WriteContext,
} from "./members-writes.ts";
import { formatMoney } from "./money.ts";
import type { PaneProps } from "./panes.tsx";
import { monthAndDay, type Period, periodName } from "./period.ts";
import { type Route, withQuery } from "./route.ts";
import { keepLoading } from "./use-loaded.ts";
import { useViewedPeriod, useViewing } from "./viewing.ts";

/** The status chips: `show=attention|canceled` (absent: all). */
const statusFilters = [
	{ slug: "all", label: "All", show: null },
	{ slug: "attention", label: "Needs attention", show: "attention" },
	{ slug: "canceled", label: "Canceled", show: "canceled" },
] as const;
/** The Role chips: `role=admins|members` (absent: all). */
const roleFilters = [
	{ slug: "all", label: "All", role: null },
	{ slug: "admins", label: "Owners & admins", role: "admins" },
	{ slug: "members", label: "Members", role: "members" },
] as const;

/** The actions that open a modal with nothing to choose first (the others name a role, a booking or a person). */
const modalActions: Partial<Record<MenuAction, Action>> = {
	invoice: { kind: "invoice" },
	adjust: { kind: "adjust" },
	refund: { kind: "refund", bookingId: null },
	release: { kind: "pick" },
	switch: { kind: "switch" },
	cancel: { kind: "cancel" },
	resume: { kind: "resume" },
	audit: { kind: "audit" },
};
const columns = [
	["member", "Member"],
	["role", "Role"],
	["plan", "Plan"],
	["available", ""],
	["bar", "Balance"],
	["expires", "Expires"],
	["actions", "Actions"],
] as const;

/** No lists: a role holder with no plan has no bookings, payments or history of its own. */
const noDetail: MemberDetail = {
	bookings: [],
	payments: [],
	refundable: [],
	history: [],
	stripeDashboardUrl: null,
};

/** Everything the tab reads before it can show anything. */
type Loaded = {
	key: string;
	members: Member[];
	people: Person[];
	summary: MembersSummary;
	income: number;
	capabilities: Capabilities;
	invoiceItems: InvoiceItem[];
	switchTiers: SwitchTier[];
};

/** Every page of the members list (brief A item 1 pages at 100). */
async function readMembers(
	reader: MembersReader,
	schoolId: string,
): Promise<Member[]> {
	const members: Member[] = [];
	let cursor: string | undefined;
	do {
		const page = await reader.members(
			cursor === undefined ? { schoolId } : { schoolId, cursor },
		);
		members.push(...page.members);
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	return members;
}

type Row = {
	person: Person;
	member: Member | null;
	standing: Standing | null;
	reasons: ReturnType<typeof attentionOf>;
};

function MemberRow({
	row,
	changes,
	school,
	unit,
	menuOpen,
	onOpen,
	onMenu,
	onViewAs,
}: {
	row: Row;
	changes: Change[];
	school: School;
	unit: MembersSummary["unit"];
	menuOpen: boolean;
	onOpen: () => void;
	onMenu: (button: HTMLElement, focusFirst: boolean) => void;
	onViewAs: () => void;
}): JSX.Element {
	const { person, member, standing, reasons } = row;
	const balance = member?.balances[0];
	const projection = balance ? project(balance, person.id, changes) : null;
	return (
		<tr
			class="row"
			data-test="member-row"
			data-id={person.id}
			onClick={(event) => {
				if (
					!(event.target instanceof Element && event.target.closest("button"))
				)
					onOpen();
			}}
		>
			<td>
				<b data-test="member-name">
					<button
						type="button"
						class="member-open"
						aria-haspopup="dialog"
						onClick={onOpen}
					>
						{person.name}
					</button>
				</b>
				{person.you && (
					<>
						{" "}
						<span class="mut" data-test="you-tag">
							(you)
						</span>
					</>
				)}
				{person.family && (
					<span
						class="kfam"
						data-test="family-chip"
						title={`Family key ${person.family.key}`}
					>
						<Icon name="users" />
						{person.family.label}
					</span>
				)}
				<div class="mono mut" data-test="member-id">
					{person.id}
				</div>
			</td>
			<td>
				<RoleChip role={person.role} />
				<FinanceChip person={person} />
				<AudienceChip person={person} />
			</td>
			{member && balance && projection && standing ? (
				<>
					<td>
						<span data-test="member-plan">
							{member.tierName} ×{member.quantity}
						</span>{" "}
						{reasons.length > 0 ? (
							<AttentionBadges reasons={reasons} unitPlural={unit.other} />
						) : (
							standing.canceled && (
								<span class="badge" data-test="status-badge">
									Canceled
								</span>
							)
						)}
						{standing.cancelsAtPeriodEnd && (
							<>
								{" "}
								<span class="badge" data-test="status-badge">
									Cancels {formatDay(member.currentPeriodEnd, school.timeZone)}
								</span>
							</>
						)}
					</td>
					<td class="member-bar">
						<BalanceBar balance={balance} projection={projection} />
					</td>
					<td class="r" data-test="member-available">
						{projection.reported}
						{projection.available !== projection.reported && (
							<>
								{" "}
								<span
									class="badge b-warn"
									data-test="pending-badge"
									title="Shows after the pending change ships"
								>
									<Icon name="clock" />→ {projection.available}
								</span>
							</>
						)}
						/{balance.granted}
						{projection.held > 0 && (
							<>
								{" "}
								<span
									class="badge"
									data-test="held-badge"
									title="Held for upcoming bookings"
								>
									+{projection.held} held
								</span>
							</>
						)}
					</td>
					<td
						class={
							!standing.endsToday && balance.expiresAt === null
								? "mut"
								: undefined
						}
						data-test="member-expires"
					>
						{standing.endsToday
							? "Today"
							: balance.expiresAt === null
								? "—"
								: formatDay(balance.expiresAt, school.timeZone)}
					</td>
				</>
			) : (
				<>
					<td class="knoplan" data-test="member-plan">
						No plan
					</td>
					<td class="member-bar" />
					<td class="r knoplan" data-test="member-available">
						no plan
					</td>
					<td class="mut" data-test="member-expires">
						—
					</td>
				</>
			)}
			<td class="r">
				{member && (
					<>
						<button
							type="button"
							class="btn ico s"
							data-test="view-as-member"
							aria-label={`View ${person.name} as member`}
							title="View as member"
							onClick={onViewAs}
						>
							<Icon name="eye" />
						</button>{" "}
					</>
				)}
				<MenuButton name={person.name} expanded={menuOpen} onOpen={onMenu} />
			</td>
		</tr>
	);
}

function FinanceOnlyValue(): JSX.Element {
	return (
		<span class="khid" data-hid="no_grant" title={financeOnly.title}>
			<Icon name="lock" />
			{financeOnly.text}
		</span>
	);
}

type RosterProps = {
	loaded: Loaded;
	reader: Reader;
	writer: MembersWriter;
	school: School;
	clock: Clock;
	period: Period;
	route: Route;
	navigate: (route: Route) => void;
	onRendered: () => void;
	onToast: (text: string) => void;
	pendingBookings: ReadonlySet<string>;
	onPendingBookings: PaneProps["onPendingBookings"];
};

type Menu = {
	personId: string;
	place: "row" | "drawer";
	anchor: HTMLElement;
	focusFirst: boolean;
};

/** The roster, once the Reader has answered: the state the tab keeps (search, the open menu, the open modal and the
 * writes whose effect is pending) and what it shows. */
function Roster({
	loaded,
	reader,
	writer,
	school,
	clock,
	period,
	route,
	navigate,
	onRendered,
	onToast,
	pendingBookings,
	onPendingBookings,
}: RosterProps): JSX.Element {
	const { summary, capabilities } = loaded;
	const { unit } = summary;
	const [details, setDetails] = useState<Record<string, MemberDetail>>({});
	const [ownChanges, setChanges] = useState<Change[]>([]);
	/** What this tab wrote, and the bookings either tab has a write on the way for. */
	const changes: Change[] = [
		...ownChanges,
		...[...pendingBookings].map(
			(bookingId): Change => ({ kind: "booking", bookingId }),
		),
	];
	const [search, setSearch] = useState("");
	const [menu, setMenu] = useState<Menu | null>(null);
	const [modal, setModal] = useState<{
		personId: string;
		action: Action;
	} | null>(null);
	const [busy, setBusy] = useState<{
		bookingId: string;
		action: BookingAction;
	} | null>(null);
	const requested = useRef(new Set<string>());
	const menuNow = useRef(menu);
	menuNow.current = menu;
	/** The button that was in use when an action started: focus goes back to it when the modal closes. */
	const returnFocus = useRef<HTMLElement | null>(null);
	const drawerOpener = useRef<string | null>(null);

	const drawerId = route.query.get("member");
	const menuPersonId = menu?.personId ?? null;
	useEffect(() => {
		for (const id of [drawerId, menuPersonId]) {
			if (id === null || requested.current.has(id)) continue;
			if (
				!loaded.people.some((person) => person.id === id && person.planHolder)
			)
				continue;
			requested.current.add(id);
			reader
				.memberDetail({ schoolId: school.id, personId: id })
				.then(
					(detail) => setDetails((before) => ({ ...before, [id]: detail })),
					keepLoading,
				);
		}
	}, [reader, school.id, drawerId, menuPersonId, loaded.people]);

	const people = applyRoles(loaded.people, changes);
	const viewer = viewerOf(useViewing());
	const detailOf = (person: Person): MemberDetail | undefined =>
		person.planHolder ? details[person.id] : noDetail;
	const drawerPerson = people.find(({ id }) => id === drawerId);
	const drawerDetail = drawerPerson ? detailOf(drawerPerson) : undefined;
	const settled = drawerPerson === undefined || drawerDetail !== undefined;
	useLayoutEffect(() => {
		if (settled) onRendered();
	});
	const modalOpen = modal !== null;
	useEffect(() => {
		if (!modalOpen && returnFocus.current?.isConnected)
			returnFocus.current.focus();
		if (!modalOpen) returnFocus.current = null;
	}, [modalOpen]);
	useEffect(() => {
		if (drawerId !== null || drawerOpener.current === null) return;
		document
			.querySelector<HTMLElement>(
				`[data-test=member-row][data-id="${drawerOpener.current}"] .member-open`,
			)
			?.focus();
		drawerOpener.current = null;
	}, [drawerId]);

	if (!viewer.roster)
		return <LockPanel lock={rosterLock} icon="users" hooks="roster" />;

	const go = (name: string, value: string | null): void =>
		navigate(withQuery(route, name, value));
	const memberOf = (person: Person): Member | null =>
		loaded.members.find(({ profileId }) => profileId === person.id) ?? null;
	const renewalOf = (member: Member | null): string =>
		member ? formatDay(member.currentPeriodEnd, school.timeZone) : "";
	const writeContextOf = (person: Person): WriteContext => ({
		writer,
		schoolId: school.id,
		schoolName: school.name,
		now: clock.now,
		unit,
		rules: summary.bookingRules,
		person,
		renewal: renewalOf(memberOf(person)),
	});
	const contextOf = (person: Person): PersonContext | null => {
		const detail = detailOf(person);
		return detail
			? {
					person,
					people,
					member: memberOf(person),
					detail,
					capabilities,
					viewer,
					changes,
					creditUnit: unit.other,
				}
			: null;
	};

	const rows: Row[] = people.map((person) => {
		const member = memberOf(person);
		const standing = member ? standingOf(member, changes) : null;
		return {
			person,
			member,
			standing,
			reasons: attentionOf(person, standing?.canceled ?? false, changes),
		};
	});
	const attentionCount = rows.filter(
		({ reasons }) => reasons.length > 0,
	).length;
	const roleCounts = {
		all: rows.length,
		admins: rows.filter(({ person }) => person.role !== "member").length,
		members: rows.filter(({ person }) => person.role === "member").length,
	};
	const show = route.query.get("show");
	const roleAsked = route.query.get("role");
	const plan = route.query.get("plan");
	const needle = search.toLowerCase();
	const listed = rows
		.filter(({ person, member, standing, reasons }) => {
			const plate = member ? `${member.tierName} ×${member.quantity}` : "";
			const status = standing?.canceled ? "canceled" : (member?.status ?? "");
			const text =
				`${person.id} ${person.name} ${plate} ${status} ${roleLabels[person.role]}`.toLowerCase();
			return (
				text.includes(needle) &&
				(show === "attention"
					? reasons.length > 0
					: show === "canceled"
						? standing?.canceled === true
						: true) &&
				(plan === null ||
					member?.tierName === plan ||
					member?.tierId === plan) &&
				(roleAsked === "admins"
					? person.role !== "member"
					: roleAsked === "members"
						? person.role === "member"
						: true)
			);
		})
		.sort(
			(first, second) =>
				attentionScore(second.reasons) - attentionScore(first.reasons) ||
				roleRank(first.person) - roleRank(second.person) ||
				first.person.name.localeCompare(second.person.name),
		);

	// ---- Effects of writes

	const apply = ({ changes: added, toast }: Applied): void => {
		setChanges((before) => [...before, ...added]);
		const bookingIds = added.flatMap((change) =>
			change.kind === "booking" ? [change.bookingId] : [],
		);
		if (bookingIds.length > 0)
			onPendingBookings(
				school.id,
				(before) => new Set([...before, ...bookingIds]),
			);
		setModal(null);
		setBusy(null);
		onToast(toast);
	};
	const fail = (): void => {
		setBusy(null);
		onToast(failedToast);
	};
	/** A booking button of the drawer that needs no modal: the button waits while the call is on its way. */
	const runQuick = async (
		started: { bookingId: string; action: BookingAction },
		write: () => Promise<Applied>,
	): Promise<void> => {
		setBusy(started);
		let applied: Applied;
		try {
			applied = await write();
		} catch {
			fail();
			return;
		}
		apply(applied);
	};

	// ---- Menu, drawer and actions

	const closeMenu = (back: boolean): void => {
		if (back) menuNow.current?.anchor.focus();
		setMenu(null);
	};
	const toggleMenu =
		(personId: string, place: Menu["place"]) =>
		(anchor: HTMLElement, focusFirst: boolean): void =>
			setMenu(
				menu?.personId === personId && menu.place === place
					? null
					: { personId, place, anchor, focusFirst },
			);
	const openDrawer = (personId: string): void => {
		drawerOpener.current = personId;
		go("member", personId);
	};
	const startModal = (personId: string, action: Action): void => {
		returnFocus.current =
			menu?.anchor ??
			(document.activeElement instanceof HTMLElement
				? document.activeElement
				: null);
		setMenu(null);
		setModal({ personId, action });
	};
	const downloadPayments = (person: Person): void => {
		const detail = detailOf(person);
		if (!detail) return;
		const rowsOfPayments = paymentsOf(detail, person.id, changes, clock.today);
		saveCsv(saveFile, onToast, {
			name: csvFileNames.history(
				person.id,
				rowsOfPayments.map(({ date }) => date),
				clock.today,
			),
			columns: historyColumns(false),
			rows: rowsOfPayments.map(
				(row): HistoryCsvRow => ({
					...row,
					member: person.id,
					currency: summary.currency,
					invoiceId: row.invoiceId ?? "",
					paymentId: row.paymentId ?? "",
				}),
			),
		});
	};
	const choose = (person: Person, chosen: MenuAction): void => {
		const change = roleActions[chosen];
		const opened: Action | undefined = change
			? { kind: "role", change }
			: modalActions[chosen];
		if (opened) {
			startModal(person.id, opened);
			return;
		}
		setMenu(null);
		if (chosen === "view-as-member")
			navigate(withQuery(route, "portal", person.id));
		else if (chosen === "csv") downloadPayments(person);
		else if (chosen === "stripe") onToast("Opening Stripe dashboard…");
		else onToast(`Receipt resent to ${endSentence(person.name)}`);
	};
	const bookingAction = (
		person: Person,
		action: BookingAction,
		booking: MemberBooking,
	): void => {
		const inside = insideCutoffOf(person, booking);
		const needsDialog =
			action === "release" &&
			inside &&
			summary.bookingRules.lateCancel === "spend";
		if (action === "remind") onToast(reminderToast(booking.hosts));
		else if (action === "noshow")
			startModal(person.id, { kind: "noshow", bookingId: booking.id });
		else if (action === "refund")
			startModal(person.id, { kind: "refund", bookingId: booking.id });
		else if (needsDialog)
			startModal(person.id, { kind: "release", bookingId: booking.id });
		else {
			const write = writeContextOf(person);
			runQuick({ bookingId: booking.id, action }, () =>
				action === "confirm"
					? recordOutcome(write, booking, "attended")
					: releaseHold(write, booking, { waive: false, inside, quick: true }),
			);
		}
	};

	const menuPerson = menu
		? people.find(({ id }) => id === menu.personId)
		: undefined;
	const menuContext = menuPerson ? contextOf(menuPerson) : null;
	const modalPerson = modal
		? people.find(({ id }) => id === modal.personId)
		: undefined;
	const modalDetail = modalPerson ? detailOf(modalPerson) : undefined;
	const drawerContext = drawerPerson ? contextOf(drawerPerson) : null;

	const expiring = summary.expiringGifts;
	const currency = summary.currency;
	return (
		<>
			<div class="strip">
				<div class="stat" data-test="members-stat" data-stat="outstanding">
					<small data-test="stat-label">
						<Icon name="ticket" /> {unit.other} outstanding (incl. held)
					</small>
					<b data-test="stat-value">{summary.creditsOutstanding}</b>
				</div>
				<div class="stat" data-test="members-stat" data-stat="income">
					<small data-test="stat-label">
						<Icon name="coin" /> income · {periodName(period)}
					</small>
					<b data-test="stat-value">
						{viewer.finance ? (
							formatMoney(loaded.income, currency)
						) : (
							<FinanceOnlyValue />
						)}
					</b>
				</div>
				<button
					type="button"
					class="stat"
					data-test="members-stat"
					data-stat="attention"
					onClick={() => go("show", "attention")}
				>
					<small data-test="stat-label">
						<Icon name="alert" /> need attention
					</small>
					<b class="neg" data-test="stat-value">
						{attentionCount}
					</b>
				</button>
			</div>
			{expiring.length > 0 && (
				<div class="note" data-test="members-note">
					<Icon name="alert" />
					<span>
						{expiring.length} unredeemed gift{expiring.length === 1 ? "" : "s"}{" "}
						expire{expiring.length === 1 ? "s" : ""} within 30 days (
						{expiring
							.map(
								({ maskedCode, expiresOn }) =>
									`${maskedCode} · ${monthAndDay(expiresOn)}`,
							)
							.join(", ")}
						)
					</span>
					<span class="sp" />
					<button
						type="button"
						class="link"
						data-test="members-note-link"
						onClick={() => navigate({ ...route, tab: "promos" })}
					>
						View promos
					</button>
				</div>
			)}
			<div class="tools">
				<span class="sbox">
					<Icon name="search" />
					<input
						type="search"
						data-test="member-search"
						placeholder="Search name or id"
						aria-label="Search members"
						value={search}
						onInput={(event) => setSearch(event.currentTarget.value)}
					/>
				</span>
				{statusFilters.map((filter) => (
					<button
						key={filter.slug}
						type="button"
						class={
							filter.show ===
							(show === "attention" || show === "canceled" ? show : null)
								? "chip f on"
								: "chip f"
						}
						data-test="member-filter"
						data-filter={filter.slug}
						onClick={() => go("show", filter.show)}
					>
						{filter.slug === "attention" && <Icon name="alert" />}
						{filter.label}
						{filter.slug === "attention" ? ` (${attentionCount})` : ""}
					</button>
				))}
				{plan !== null && (
					<span class="chip on" data-test="plan-filter">
						Plan: {plan}{" "}
						<button
							type="button"
							class="plan-clear"
							data-test="plan-filter-clear"
							aria-label="Clear the plan filter"
							onClick={() => go("plan", null)}
						>
							×
						</button>
					</span>
				)}
				<span class="sp" />
				<span class="mut" data-test="members-sort-note">
					Needs attention first
				</span>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: a fieldset would draw its frame around the chips; this is the mockup's row with its label */}
			<div class="tools" role="group" aria-label="Role">
				<span class="mut">Role</span>
				{roleFilters.map((filter) => {
					const selected =
						filter.role ===
						(roleAsked === "admins" || roleAsked === "members"
							? roleAsked
							: null);
					return (
						<button
							key={filter.slug}
							type="button"
							class={selected ? "chip on" : "chip"}
							data-test="role-filter"
							data-role-filter={filter.slug}
							aria-pressed={selected}
							onClick={() => go("role", filter.role)}
						>
							{filter.label} <span class="mut">{roleCounts[filter.slug]}</span>
						</button>
					);
				})}
			</div>
			<table>
				<thead>
					<tr>
						{columns.map(([column, label]) => (
							<th key={column} data-test="members-column" data-column={column}>
								{column === "available" ? (
									`${capitalized(unit.other)} available`
								) : column === "bar" || column === "actions" ? (
									<span class="visually-hidden">{label}</span>
								) : (
									label
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{listed.length === 0 ? (
						<tr>
							<td
								colSpan={columns.length}
								class="mut members-empty"
								data-test="members-empty"
							>
								{people.length > 0
									? "No members match."
									: "No members yet. They appear here when someone buys a plan."}
							</td>
						</tr>
					) : (
						listed.map((row) => (
							<MemberRow
								key={row.person.id}
								row={row}
								changes={changes}
								school={school}
								unit={unit}
								menuOpen={
									menu?.personId === row.person.id && menu.place === "row"
								}
								onOpen={() => openDrawer(row.person.id)}
								onMenu={toggleMenu(row.person.id, "row")}
								onViewAs={() => choose(row.person, "view-as-member")}
							/>
						))
					)}
				</tbody>
			</table>
			<div class="legend" data-test="members-legend">
				<span>
					<i style={{ background: "var(--muted-foreground)", opacity: 0.55 }} />
					used
				</span>
				<span>
					<i
						style={{
							background:
								"repeating-linear-gradient(135deg,var(--warning) 0 3px,transparent 3px 6px)",
						}}
					/>
					held for bookings
				</span>
				<span>
					<i style={{ background: "var(--primary)" }} />
					available
				</span>
			</div>
			{drawerPerson && drawerContext && (
				<MemberDrawer
					key={drawerPerson.id}
					context={drawerContext}
					school={school}
					unit={unit}
					today={clock.today}
					menuOpen={
						menu?.personId === drawerPerson.id && menu.place === "drawer"
					}
					trapActive={menu === null && modal === null}
					busy={busy}
					onMenu={toggleMenu(drawerPerson.id, "drawer")}
					onClose={() => go("member", null)}
					onAction={(chosen) => choose(drawerPerson, chosen)}
					onBookingAction={(action, booking) =>
						bookingAction(drawerPerson, action, booking)
					}
				/>
			)}
			{menu && menuPerson && menuContext && (
				<MemberMenu
					context={menuContext}
					anchor={menu.anchor}
					focusFirst={menu.focusFirst}
					onChoose={(chosen) => choose(menuPerson, chosen)}
					onClose={closeMenu}
				/>
			)}
			{modal && modalPerson && modalDetail && (
				<ActionModal
					action={modal.action}
					context={
						{
							write: writeContextOf(modalPerson),
							member: memberOf(modalPerson),
							detail: modalDetail,
							changes,
							currency,
							invoiceItems: loaded.invoiceItems,
							switchTiers: loaded.switchTiers,
							insideCutoff: (booking) => insideCutoffOf(modalPerson, booking),
							onDone: apply,
							onFailed: fail,
							onCancel: () => setModal(null),
						} satisfies ModalContext
					}
					onPick={(booking) =>
						setModal({
							personId: modalPerson.id,
							action: { kind: "release", bookingId: booking.id },
						})
					}
				/>
			)}
		</>
	);
}

/** The Members tab (protocol §10 S4): loads the roster for the school and the money period, then hands it to
 * `Roster`. The money period is the hash's `month=`, else the one the school's Dashboard opens on. */
export function Members({
	reader,
	writer,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
	pendingBookings,
	onPendingBookings,
}: {
	reader: Reader;
	writer: Writer;
	school: School;
	clock: Clock;
	route: Route;
	navigate: (route: Route) => void;
	/** Called after each render that shows the route's roster, or its lock panel. */
	onRendered: () => void;
	onToast: (text: string) => void;
	/** The school's bookings with a write on their way, kept by the shell (Bookings shows them too). */
	pendingBookings: ReadonlySet<string>;
	onPendingBookings: PaneProps["onPendingBookings"];
}): JSX.Element | null {
	const asked = route.query.get("month");
	const period = useViewedPeriod(
		asked,
		clock.today,
		school.dashboardOpensOn ?? null,
	);
	const key = `${school.id}/${period.from}/${period.to}`;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		let current = true;
		const load = async (): Promise<void> => {
			const query = { schoolId: school.id };
			const [
				members,
				people,
				summary,
				income,
				capabilities,
				invoiceItems,
				switchTiers,
			] = await Promise.all([
				readMembers(reader, school.id),
				reader.people(query),
				reader.membersSummary(query),
				reader.membersIncome({ ...query, from: period.from, to: period.to }),
				reader.capabilities(query),
				reader.invoiceItems(query),
				reader.switchTiers(query),
			]);
			if (current)
				setLoaded({
					key,
					members,
					people,
					summary,
					income,
					capabilities,
					invoiceItems,
					switchTiers,
				});
		};
		load().catch(keepLoading);
		return () => {
			current = false;
		};
	}, [reader, school.id, period.from, period.to, key]);
	if (loaded?.key !== key) return null;
	return (
		<Roster
			loaded={loaded}
			reader={reader}
			writer={writer}
			school={school}
			clock={clock}
			period={period}
			route={route}
			navigate={navigate}
			onRendered={onRendered}
			onToast={onToast}
			pendingBookings={pendingBookings}
			onPendingBookings={onPendingBookings}
		/>
	);
}
