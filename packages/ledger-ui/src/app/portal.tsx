import type { JSX } from "preact";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useState,
} from "preact/hooks";
import type { KpiDocument } from "../data/kpi-document.ts";
import { type HistoryCsvRow, historyColumns } from "../data/ledger.ts";
import {
	type HistoryPeriod,
	historyCsvFileName,
	historyPeriods,
	type MemberPortal,
	type PortalBooking,
	type PortalHistoryRow,
	type PortalMember,
	paymentStatusLabels,
	portalFrameVariables,
	type SiteThemeId,
	siteThemeIds,
	siteThemes,
} from "../data/portal.ts";
import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { endSentence, failedToast } from "./booking-text.ts";
import { saveFile } from "./download.ts";
import { saveCsv } from "./download-button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { rosterLock, viewerOf } from "./members-model.ts";
import { formatMoney } from "./money.ts";
import type { AudienceMove } from "./plans-menu.ts";
import {
	CancelDialog,
	EmbedDialog,
	QuantityDialog,
	ResumeDialog,
} from "./portal-dialogs.tsx";
import { type Change, count, planOf } from "./portal-format.ts";
import {
	BillingTab,
	BookingsTab,
	bookingsOf,
	FamilyTab,
	familyRoleLabel,
	type HistoryControls,
	Overview,
	type PortalTab,
	publishedPeriod,
} from "./portal-views.tsx";
import { type Route, withQuery } from "./route.ts";
import { keepLoading } from "./use-loaded.ts";
import { useViewing } from "./viewing.ts";

const defaultTab: PortalTab = "overview";
const defaultTheme: SiteThemeId = "b4u";
const defaultPeriod: HistoryPeriod = "all";
const tabs: Array<{ id: PortalTab; label: string; icon: IconName }> = [
	{ id: "overview", label: "Overview", icon: "user" },
	{ id: "bookings", label: "Bookings", icon: "calendar" },
	{ id: "billing", label: "Billing", icon: "card" },
	{ id: "family", label: "Family", icon: "users" },
];
/** The parameters that open the portal and shape it; Exit removes them all. */
const portalParameters = [
	"portal",
	"portalTab",
	"siteTheme",
	"history",
	"historyAll",
];

/** `portalTab=overview|bookings|billing|family` (absent: overview). */
const readTab = (query: URLSearchParams): PortalTab =>
	tabs.find(({ id }) => id === query.get("portalTab"))?.id ?? defaultTab;
/** `siteTheme=b4u|host|dark` (absent: b4u). */
const readTheme = (query: URLSearchParams): SiteThemeId =>
	siteThemeIds.find((id) => id === query.get("siteTheme")) ?? defaultTheme;
/** `history=all|this|last` (absent: all). */
const readPeriod = (query: URLSearchParams): HistoryPeriod =>
	historyPeriods.find(({ id }) => id === query.get("history"))?.id ??
	defaultPeriod;

type Loaded = {
	key: string;
	portal: MemberPortal | undefined;
	/** The document the School books card reads, when the card shows figures. */
	figures: KpiDocument | null;
	/** The year the public school-books document publishes last, for the embed snippet. */
	publicYear: string;
};

type Dialog = "quantity" | "cancel" | "resume" | "embed";

type PaneProps = {
	reader: Reader;
	writer: Writer;
	school: School;
	clock: Clock;
	route: Route;
	navigate: (route: Route) => void;
	/** Called after each render that shows what the route asks for. */
	onRendered: () => void;
	onToast: (text: string) => void;
	/** The tiers of this school a publish gave another audience, by tier id (kept by the shell). */
	audienceMoves: Record<string, AudienceMove>;
	/** Says whether the portal covers the page, so the shell can put what it covers out of reach. */
	onShownChange: (shown: boolean) => void;
};

/** What takes the Members pane while `portal=` is in the route (mockup `#vm`): the member portal for the audiences that
 * see the roster, else the lock panel that stands in for it. */
export function PortalPane(props: PaneProps): JSX.Element {
	const viewing = useViewing();
	const { option, preview } = viewing;
	const { onRendered } = props;
	useLayoutEffect(() => {
		if (!option.admin) onRendered();
	});
	if (!option.admin)
		return <LockPanel lock={rosterLock} icon="users" hooks="roster" />;
	return (
		<Portal {...props} preview={preview} finance={viewerOf(viewing).finance} />
	);
}

/** The member portal (mockup `drawVM`): one person's view as the server scopes it, in the school's site theme.
 * The preview bar, the scope banner and the note are the admin's; inside the frame is exactly what the member sees.
 * Changes the member asks for are sent through the Writer and shown as "on its way" until the Reader says them. */
function Portal({
	reader,
	writer,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
	onShownChange,
	preview,
	finance,
	audienceMoves,
}: PaneProps & { preview: boolean; finance: boolean }): JSX.Element | null {
	const profileId = route.query.get("portal") ?? "";
	const tab = readTab(route.query);
	const themeId = readTheme(route.query);
	const period = readPeriod(route.query);
	const expanded = route.query.get("historyAll") === "1";
	const key = `${school.id}/${profileId}`;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [changes, setChanges] = useState<Record<string, Change>>({});
	const [pendingBookings, setPendingBookings] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const themeSelectId = useId();
	useEffect(() => {
		let current = true;
		const load = async (): Promise<void> => {
			const portal = await reader.memberPortal({
				school: school.id,
				profileId,
			});
			let figures: KpiDocument | null = null;
			let publicYear = "";
			if (portal) {
				const options = await reader.dashboardOptions();
				const preset = options.presets[0].id;
				const read = (audience: "public" | "member") =>
					reader.kpiDocument({
						school: school.id,
						preset,
						audience,
						pinLocked: false,
					});
				const { audience, guardian } = portal.books;
				const [publicDocument, memberDocument] = await Promise.all([
					read("public"),
					audience === "member" && !guardian ? read("member") : undefined,
				]);
				const booksDocument =
					audience === "public" && !guardian ? publicDocument : memberDocument;
				figures = booksDocument ?? null;
				publicYear = publicDocument
					? (publishedPeriod(publicDocument)?.period ?? "")
					: "";
			}
			if (current) setLoaded({ key, portal, figures, publicYear });
		};
		load().catch(keepLoading);
		return () => {
			current = false;
		};
	}, [reader, school.id, profileId, key]);
	const shown = loaded?.key === key ? loaded : null;
	const loadedPortal = shown?.portal;
	const viewed = loadedPortal?.people.find(
		(person) => person.profileId === profileId,
	);
	/** A publish that gave the member's tier another audience: they read it at once, before the Reader says it. A
	 * child's books are the guardian's, so a tier's move does not reach them. */
	const move = viewed ? audienceMoves[viewed.tierId] : undefined;
	const portal =
		loadedPortal && move && !loadedPortal.books.guardian
			? {
					...loadedPortal,
					books: { ...loadedPortal.books, audience: move.audience },
				}
			: loadedPortal;
	const visible = Boolean(portal && viewed);
	useLayoutEffect(() => {
		if (shown) onRendered();
	});
	useEffect(() => {
		onShownChange(visible);
		return () => onShownChange(false);
	}, [visible, onShownChange]);
	const exit = useCallback(
		() =>
			navigate(
				portalParameters.reduce(
					(next, name) => withQuery(next, name, null),
					route,
				),
			),
		[navigate, route],
	);
	useEffect(() => {
		if (!visible) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && dialog === null) exit();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [visible, dialog, exit]);
	if (!(shown && portal && viewed)) return null;

	const plan = planOf(viewed, changes[viewed.profileId], school);
	const theme = siteThemes[themeId];
	const setParameter = (name: string, value: string | null): void =>
		navigate(withQuery(route, name, value));
	const mergeChange = (changedId: string, change: Partial<Change>): void =>
		setChanges((before) => ({
			...before,
			[changedId]: { waiting: true, ...before[changedId], ...change },
		}));
	const fail = (changedId: string): void => {
		mergeChange(changedId, { waiting: false });
		onToast(failedToast);
	};

	const changeQuantity = async (
		member: PortalMember,
		quantity: number,
	): Promise<void> => {
		setDialog(null);
		mergeChange(member.profileId, { waiting: true });
		try {
			const result = await writer.portalChangeQuantity({
				school: school.id,
				profileId: member.profileId,
				quantity,
			});
			if (result.at === "renewal") {
				mergeChange(member.profileId, { scheduledQuantity: quantity });
				onToast(`Change to ×${quantity} scheduled for ${plan.endsOn}.`);
			} else {
				mergeChange(member.profileId, { quantity });
				onToast(
					`Upgraded to ×${quantity}. Charged ${formatMoney(result.chargedCents, school.currency)} and ${count(result.granted, school.creditUnit)} added once it ships.`,
				);
			}
		} catch {
			fail(member.profileId);
		}
	};
	const cancelMembership = async (
		member: PortalMember,
		reason: string,
	): Promise<void> => {
		setDialog(null);
		mergeChange(member.profileId, { waiting: true });
		try {
			await writer.portalCancelMembership({
				school: school.id,
				profileId: member.profileId,
				...(reason === "" ? {} : { reason }),
			});
			mergeChange(member.profileId, { ending: true });
			onToast(`Membership will end on ${plan.endsOn}.`);
		} catch {
			fail(member.profileId);
		}
	};
	const resumeMembership = async (member: PortalMember): Promise<void> => {
		setDialog(null);
		mergeChange(member.profileId, { waiting: true });
		try {
			await writer.portalResumeMembership({
				school: school.id,
				profileId: member.profileId,
			});
			mergeChange(member.profileId, { ending: false });
			onToast("Membership resumed.");
		} catch {
			fail(member.profileId);
		}
	};
	const cancelBooking = async (booking: PortalBooking): Promise<void> => {
		setPendingBookings((before) => new Set([...before, booking.id]));
		try {
			await writer.portalCancelBooking({
				school: school.id,
				profileId: booking.profileId,
				bookingId: booking.id,
			});
			onToast(`Hold released for ${endSentence(viewed.name)}`);
		} catch {
			setPendingBookings(
				(before) => new Set([...before].filter((id) => id !== booking.id)),
			);
			onToast(failedToast);
		}
	};
	const copySnippet = async (snippet: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(snippet);
			onToast("Snippet copied.");
		} catch {
			onToast("Could not copy the snippet: the browser blocked the clipboard.");
		}
	};
	const downloadHistory = (rows: PortalHistoryRow[]): void => {
		saveCsv(saveFile, onToast, {
			name: historyCsvFileName(viewed.profileId, rows),
			columns: historyColumns(portal.scope === "family"),
			rows: rows.map(
				(row): HistoryCsvRow => ({
					...row,
					member: row.profileId,
					status: paymentStatusLabels[row.status],
				}),
			),
		});
	};

	const controls: HistoryControls = {
		finance,
		period,
		expanded,
		onPeriod: (chosen) =>
			setParameter("history", chosen === defaultPeriod ? null : chosen),
		onExpand: () => setParameter("historyAll", expanded ? null : "1"),
		onDownload: downloadHistory,
	};
	const view = {
		school,
		clock,
		portal,
		viewed,
		plan,
		preview,
		pendingBookings,
		handlers: {
			onQuantity: () => setDialog("quantity"),
			onCancel: () => setDialog("cancel"),
			onResume: () => setDialog("resume"),
			onCard: () =>
				onToast(
					"Opens Stripe's billing portal. Card details stay with Stripe.",
				),
			onBuy: (addonId: string) => {
				const addon = portal.addons.find(({ id }) => id === addonId);
				onToast(
					`Member would continue to Stripe Checkout for ${addon?.name ?? ""}.`,
				);
			},
			onBooks: onToast,
			onCancelBooking: cancelBooking,
		},
	};
	const bookingCount = bookingsOf(portal, viewed.profileId).length;
	const scopeText = (() => {
		if (portal.scope === "family" && portal.family)
			return `${portal.people.map(({ name }) => name).join(", ")} (${portal.family.label})`;
		return portal.family
			? `${viewed.name} only. Learners don't see other family members' money.`
			: `${viewed.name} only (no family on this account).`;
	})();
	const dialogContext = {
		school,
		viewed,
		plan,
		onClose: () => setDialog(null),
	};

	return (
		<>
			<section class="vm" aria-label="Member portal view" data-test="portal">
				<div class="vmbar">
					<span class="badge b-warn" data-test="portal-viewing">
						<Icon name="eye" />
						Viewing as {viewed.name}
					</span>
					<span class="mono mut" data-test="portal-id">
						{viewed.profileId} · {school.name}
					</span>
					<span class="sp" />
					<label class="mut" for={themeSelectId}>
						Site theme
					</label>
					<select
						id={themeSelectId}
						data-test="portal-theme"
						value={themeId}
						onInput={(event) =>
							setParameter(
								"siteTheme",
								event.currentTarget.value === defaultTheme
									? null
									: event.currentTarget.value,
							)
						}
					>
						{siteThemeIds.map((id) => (
							<option key={id} value={id}>
								{siteThemes[id].name}
							</option>
						))}
					</select>
					{portal.family && (
						// biome-ignore lint/a11y/useSemanticElements: the mockup's "Viewing as" row is a span group; a fieldset brings its own border and padding
						<span class="kfset" role="group" aria-label="Viewing as">
							<span class="mut">Viewing as:</span>
							<span class="seg">
								{portal.family.members.map((member) => (
									<button
										type="button"
										key={member.profileId}
										class={
											member.profileId === viewed.profileId ? "on" : undefined
										}
										aria-pressed={member.profileId === viewed.profileId}
										data-test="portal-family-switch"
										data-profile={member.profileId}
										title={member.name}
										onClick={() => setParameter("portal", member.profileId)}
									>
										{familyRoleLabel(member.familyRole)}
									</button>
								))}
							</span>
						</span>
					)}
					<button
						type="button"
						class="btn s"
						data-test="portal-embed"
						onClick={() => setDialog("embed")}
					>
						<Icon name="plug" />
						Embed…
					</button>
					<button
						type="button"
						class="btn s"
						data-test="portal-exit"
						onClick={exit}
					>
						<Icon name="xCircle" />
						Exit
					</button>
				</div>
				<div class="kscope" data-test="portal-scope">
					<Icon name="lock" />
					<b>Members see only themselves and their family.</b>
					<span class="mut">In this portal: {scopeText}</span>
				</div>
				<div class="vmnote" data-test="portal-note">
					<Icon name="info" /> This is the member portal as {viewed.name} sees
					it. This is a preview of the member's view: it shows exactly what they
					see, with no admin tools. Admin actions for this member are in the ⋯
					menu on the Members tab.
				</div>
				<div class="vmwrap">
					<div
						class="mpf"
						data-test="portal-frame"
						data-site-theme={themeId}
						style={portalFrameVariables(theme)}
					>
						<div class="mph" data-test="portal-header">
							<b>{school.name}</b>
							<span>Classes</span>
							<span>Schedule</span>
							<span>Shop</span>
							<span style="margin-left:auto">{viewed.name}</span>
						</div>
						<div class="mpb">
							<div class="mp-tabs" role="tablist">
								{tabs.map(({ id, label, icon }) => (
									<button
										type="button"
										key={id}
										role="tab"
										class={id === tab ? "on" : undefined}
										aria-selected={id === tab}
										data-test="portal-tab"
										data-portal-tab={id}
										onClick={() =>
											setParameter("portalTab", id === defaultTab ? null : id)
										}
									>
										<Icon name={icon} />
										{id === "bookings" && bookingCount > 0
											? `${label} (${bookingCount})`
											: label}
									</button>
								))}
							</div>
							{tab === "overview" && (
								<Overview
									{...view}
									figures={
										portal.books.audience === loadedPortal?.books.audience
											? shown.figures
											: null
									}
									audienceChangedOn={move?.on ?? null}
								/>
							)}
							{tab === "bookings" && <BookingsTab {...view} />}
							{tab === "billing" && (
								<BillingTab {...view} controls={controls} />
							)}
							{tab === "family" && <FamilyTab {...view} />}
						</div>
					</div>
				</div>
			</section>
			{dialog === "quantity" && (
				<QuantityDialog
					{...dialogContext}
					onConfirm={(quantity) => changeQuantity(viewed, quantity)}
				/>
			)}
			{dialog === "cancel" && (
				<CancelDialog
					{...dialogContext}
					onConfirm={(reason) => cancelMembership(viewed, reason)}
				/>
			)}
			{dialog === "resume" && (
				<ResumeDialog
					{...dialogContext}
					onConfirm={() => resumeMembership(viewed)}
				/>
			)}
			{dialog === "embed" && (
				<EmbedDialog
					school={school}
					theme={theme}
					publicYear={shown.publicYear}
					onClose={() => setDialog(null)}
					onCopy={copySnippet}
				/>
			)}
		</>
	);
}
