import type { JSX } from "preact";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "preact/hooks";
import type { KpiDocument } from "../data/kpi-document.ts";
import {
	type HistoryPeriod,
	historyCsvFileName,
	historyPeriods,
	type MemberPortal,
	type PortalBooking,
	type PortalHistoryRow,
	type PortalMember,
	portalFrameVariables,
	type SiteThemeId,
	siteThemeIds,
	siteThemes,
} from "../data/portal.ts";
import { endSentence, failedToast } from "./booking-text.ts";
import { saveFile } from "./download.ts";
import { saveCsv } from "./download-button.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { rosterLock, viewerOf } from "./members-model.ts";
import { formatMoney } from "./money.ts";
import { Pane, type PaneProps } from "./panes.tsx";
import {
	CancelDialog,
	EmbedDialog,
	QuantityDialog,
	ResumeDialog,
} from "./portal-dialogs.tsx";
import {
	type Change,
	count,
	historyCsvColumnsOf,
	planOf,
} from "./portal-format.ts";
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
import { withQuery } from "./route.ts";
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

const focusReturnMilliseconds = 3000;

/** Exit hands the page back to the Members tab, whose roster loads again. Once the person's row is there, focus goes to
 * its ⋯ button (else its name button), as a dialog returns it to the control that opened it; if focus has gone
 * somewhere else meanwhile, it stays there. */
function returnFocusToRow(profileId: string): void {
	const row = `[data-test=member-row][data-id="${profileId.replaceAll('"', '\\"')}"]`;
	const opener = (): HTMLElement | null =>
		document.querySelector<HTMLElement>(
			`${row} [data-test=member-menu-button]`,
		) ?? document.querySelector<HTMLElement>(`${row} .member-open`);
	const watcher = new MutationObserver(() => {
		const found = opener();
		if (!found) return;
		watcher.disconnect();
		const focused = document.activeElement;
		if (!focused || focused === document.body) found.focus();
	});
	watcher.observe(document.body, { childList: true, subtree: true });
	setTimeout(() => watcher.disconnect(), focusReturnMilliseconds);
}

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
function Portal(
	props: PaneProps & { preview: boolean; finance: boolean },
): JSX.Element | null {
	const {
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
		membershipChanges: changes,
		onMembershipChanges,
		pendingBookings,
		onPendingBookings,
	} = props;
	const profileId = route.query.get("portal") ?? "";
	const tab = readTab(route.query);
	const themeId = readTheme(route.query);
	const period = readPeriod(route.query);
	const expanded = route.query.get("historyAll") === "1";
	const key = `${school.id}/${profileId}`;
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const themeSelectId = useId();
	const tabsId = useId();
	useEffect(() => {
		let current = true;
		const load = async (): Promise<void> => {
			const portal = await reader.memberPortal({
				school: school.id,
				profileId,
			});
			let figures: KpiDocument | null = null;
			let publicYear = "";
			const preset = portal
				? (await reader.dashboardOptions()).presets[0]?.id
				: undefined;
			if (portal && preset !== undefined) {
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
	/** A portal= with no such person shows the Members tab without a portal (mockup `drawVM`): that pane reports its own
	 * render. */
	const missing = Boolean(shown) && !visible;
	useLayoutEffect(() => {
		if (shown && visible) onRendered();
	});
	const viewingBar = useRef<HTMLSpanElement>(null);
	const profileShown = visible ? profileId : null;
	useEffect(() => {
		if (profileShown !== null)
			viewingBar.current?.focus({ preventScroll: true });
	}, [profileShown]);
	useEffect(() => {
		onShownChange(visible);
		return () => onShownChange(false);
	}, [visible, onShownChange]);
	const exit = useCallback(() => {
		returnFocusToRow(profileId);
		navigate(
			portalParameters.reduce(
				(next, name) => withQuery(next, name, null),
				route,
			),
		);
	}, [navigate, route, profileId]);
	useEffect(() => {
		if (!visible) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && dialog === null) exit();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [visible, dialog, exit]);
	if (missing) return <Pane name="members" {...props} />;
	if (!(shown && portal && viewed)) return null;

	const plan = planOf(viewed, changes[viewed.profileId], school);
	const theme = siteThemes[themeId];
	const setParameter = (name: string, value: string | null): void =>
		navigate(withQuery(route, name, value));
	const chooseTab = (id: PortalTab): void =>
		setParameter("portalTab", id === defaultTab ? null : id);
	/** The tabs pattern, as the shell's tab strip: arrows, Home and End move to a tab and open it. */
	const onTabKeyDown = (
		event: JSX.TargetedKeyboardEvent<HTMLDivElement>,
	): void => {
		const index = tabs.findIndex(({ id }) => id === tab);
		const targets: Record<string, number> = {
			ArrowLeft: (index + tabs.length - 1) % tabs.length,
			ArrowRight: (index + 1) % tabs.length,
			Home: 0,
			End: tabs.length - 1,
		};
		const target = tabs[targets[event.key] ?? -1];
		if (!target) return;
		event.preventDefault();
		event.currentTarget
			.querySelector<HTMLElement>(`[data-portal-tab=${target.id}]`)
			?.focus();
		chooseTab(target.id);
	};
	const mergeChange = (changedId: string, change: Partial<Change>): void =>
		onMembershipChanges(school.id, (before) => ({
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
			mergeChange(member.profileId, { ending: true, endsNow: false });
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
			mergeChange(member.profileId, { ending: false, endsNow: false });
			onToast("Membership resumed.");
		} catch {
			fail(member.profileId);
		}
	};
	const cancelBooking = async (booking: PortalBooking): Promise<void> => {
		onPendingBookings(school.id, (before) => new Set([...before, booking.id]));
		try {
			await writer.portalCancelBooking({
				school: school.id,
				profileId: booking.profileId,
				bookingId: booking.id,
			});
			onToast(`Hold released for ${endSentence(viewed.name)}`);
		} catch {
			onPendingBookings(
				school.id,
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
			columns: historyCsvColumnsOf(portal.scope === "family"),
			rows,
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
					<span
						ref={viewingBar}
						class="badge b-warn"
						tabIndex={-1}
						data-test="portal-viewing"
					>
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
							<div
								class="mp-tabs"
								role="tablist"
								aria-label="Member portal"
								onKeyDown={onTabKeyDown}
							>
								{tabs.map(({ id, label, icon }) => (
									<button
										type="button"
										key={id}
										role="tab"
										id={`${tabsId}-${id}`}
										class={id === tab ? "on" : undefined}
										aria-selected={id === tab}
										aria-controls={id === tab ? `${tabsId}-panel` : undefined}
										tabIndex={id === tab ? 0 : -1}
										data-test="portal-tab"
										data-portal-tab={id}
										onClick={() => chooseTab(id)}
									>
										<Icon name={icon} />
										{id === "bookings" && bookingCount > 0
											? `${label} (${bookingCount})`
											: label}
									</button>
								))}
							</div>
							<div
								role="tabpanel"
								id={`${tabsId}-panel`}
								aria-labelledby={`${tabsId}-${tab}`}
							>
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
