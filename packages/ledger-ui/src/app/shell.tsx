import type { ComponentChildren, JSX } from "preact";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";
import type { Disclosure } from "../data/disclosure.ts";
import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { CoreIcon, type CoreIconName } from "./core-icon.tsx";
import { DialogSlot, useSlotOpener } from "./dialog-slot.tsx";
import type { Change as RosterChange } from "./members-model.ts";
import type { PaneName } from "./panes.tsx";
import { parsePeriod, snapPeriod } from "./period.ts";
import type { AudienceMove, PlansSession } from "./plans-menu.ts";
import type { Change } from "./portal-format.ts";
import {
	allSchools,
	type Route,
	type SchoolTab,
	schoolTabs,
	themeOf,
	withQuery,
} from "./route.ts";
import { SettingsDrawer } from "./settings-drawer.tsx";
import { TopBar } from "./top-bar.tsx";
import { keepLoading } from "./use-loaded.ts";
import { ViewingContext } from "./viewing.ts";

const toastMilliseconds = 4600;
const tabs: Record<SchoolTab, { label: string; icon: CoreIconName }> = {
	plans: { label: "Plans", icon: "layers" },
	dashboard: { label: "Dashboard", icon: "chart" },
	members: { label: "Members", icon: "users" },
	bookings: { label: "Bookings", icon: "calendar" },
	promos: { label: "Promos", icon: "tag" },
	ledger: { label: "Ledger", icon: "list" },
	reports: { label: "Reports", icon: "chart" },
};

const counted = (count: number, noun: string): string =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** A tab's badge from the school's counts and whether its Plans draft has changes (mockup `#plbadge`, `#bkbadge`, `#pbadge`), or null when it has none.
 * `meaning` is what a screen reader hears for the badge. */
function tabBadge(
	tab: SchoolTab,
	{ tabBadges }: School,
	plansDraft: boolean,
): { text: string; meaning: string; tone: "b-warn" | "b-bad" } | null {
	const { bookingsOverdue, promosExpiring } = tabBadges;
	if (tab === "plans" && plansDraft)
		return { text: "draft", meaning: "draft", tone: "b-warn" };
	if (tab === "bookings" && bookingsOverdue > 0)
		return {
			text: String(bookingsOverdue),
			meaning: counted(bookingsOverdue, "overdue booking"),
			tone: "b-bad",
		};
	if (tab === "promos" && promosExpiring > 0)
		return {
			text: String(promosExpiring),
			meaning: counted(promosExpiring, "expiring promo"),
			tone: "b-warn",
		};
	return null;
}

/** A module loaded on demand, once `wanted`: the panes the first time their tab opens, the popovers and the settings
 * right after the first paint, so that the first page load stays small. */
function useLazy<Loaded>(
	load: () => Promise<Loaded>,
	wanted = true,
): Loaded | null {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		if (wanted && !loaded) load().then(setLoaded);
	}, [wanted, loaded, load]);
	return loaded;
}
const noAudienceMoves: Record<string, AudienceMove> = {};
const noPendingBookings: ReadonlySet<string> = new Set();
const noMembershipChanges: Record<string, Change> = {};
const noRosterChanges: RosterChange[] = [];
const loadPanes = () => import("./panes.tsx");
const loadMenus = () => import("./menus.tsx");
const loadSettings = () => import("./settings.tsx");

type ShellProps = {
	route: Route;
	schools: School[];
	clock: Clock;
	reader: Reader;
	writer: Writer;
	navigate: (route: Route) => void;
	/** Called once a pane that loads data has rendered the route. */
	onRendered: () => void;
};

/** The mockup's frame (lines 375 to 450): top bar, tabs row, the preview banner, the stale banner, the current tab's
 * pane, the settings drawer, the modal slot and the toast. The Dashboard and Bookings fill their panes; later slices
 * fill the others. What the route views (`as=`) comes from the school's disclosure and goes to the panes through
 * `ViewingContext`. While the drawer is open the regions behind it are inert; the toast stays out of that so it can
 * still be announced. The route is ready (`onRendered`) once the disclosure and the lazy parts are loaded and the pane,
 * if it loads data, has shown it. */
export function Shell({
	route,
	schools,
	clock,
	reader,
	writer,
	navigate,
	onRendered,
}: ShellProps): JSX.Element {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [toast, setToast] = useState<{ text: string } | null>(null);
	/** A modal over the drawer (a Settings dialog), handed up by the settings so it sits outside the drawer. */
	const [modal, setModal] = useState<ComponentChildren>(null);
	useSlotOpener(modal !== null);
	/** The Members tab shows the member portal instead of the roster when the route asks for one (`portal=`). */
	const membersOpen = route.tab === "members" && !route.query.has("portal");
	const paneName: PaneName | null =
		route.tab === allSchools
			? null
			: route.tab === "members" && !membersOpen
				? "portal"
				: route.tab;
	const panes = useLazy(loadPanes, paneName !== null);
	/** Each school's plans and draft, kept for the life of the mount: leaving the tab keeps an unsaved draft, and the
	 * Plans tab's badge follows the draft. */
	const [planSessions, setPlanSessions] = useState<
		Record<string, PlansSession>
	>({});
	const keepPlanSession = useCallback(
		(
			schoolId: string,
			session: PlansSession | ((before: PlansSession) => PlansSession),
		) =>
			setPlanSessions((kept) => {
				const before = kept[schoolId];
				const next =
					typeof session === "function" ? before && session(before) : session;
				return next ? { ...kept, [schoolId]: next } : kept;
			}),
		[],
	);
	/** Each school's bookings with a write on their way, kept for the life of the mount so that a tab left and another
	 * opened agree on them. */
	const [pendingBookings, setPendingBookings] = useState<
		Record<string, ReadonlySet<string>>
	>({});
	const keepPendingBookings = useCallback(
		(
			schoolId: string,
			update: (before: ReadonlySet<string>) => ReadonlySet<string>,
		) =>
			setPendingBookings((kept) => ({
				...kept,
				[schoolId]: update(kept[schoolId] ?? noPendingBookings),
			})),
		[],
	);
	/** Each school's membership changes the member portal sent, by profile id, kept for the life of the mount. */
	const [membershipChanges, setMembershipChanges] = useState<
		Record<string, Record<string, Change>>
	>({});
	const keepMembershipChanges = useCallback(
		(
			schoolId: string,
			update: (before: Record<string, Change>) => Record<string, Change>,
		) =>
			setMembershipChanges((kept) => ({
				...kept,
				[schoolId]: update(kept[schoolId] ?? noMembershipChanges),
			})),
		[],
	);
	/** Each school's roster writes (roles, grants, credits, invoices, refunds) whose effect the ledger has not shipped,
	 * kept for the life of the mount so that the Members tab opened again, or on another period, still shows them. */
	const [rosterChanges, setRosterChanges] = useState<
		Record<string, RosterChange[]>
	>({});
	const keepRosterChanges = useCallback(
		(schoolId: string, update: (before: RosterChange[]) => RosterChange[]) =>
			setRosterChanges((kept) => ({
				...kept,
				[schoolId]: update(kept[schoolId] ?? noRosterChanges),
			})),
		[],
	);
	/** Each school's tiers a publish gave another audience, kept for the life of the mount. */
	const [audienceMoves, setAudienceMoves] = useState<
		Record<string, Record<string, AudienceMove>>
	>({});
	const keepAudienceMoves = useCallback(
		(schoolId: string, moves: Record<string, AudienceMove>) =>
			setAudienceMoves((kept) => ({
				...kept,
				[schoolId]: { ...kept[schoolId], ...moves },
			})),
		[],
	);
	/** While the member portal covers the page, the top bar and tabs behind it are out of reach. */
	const [portalShown, setPortalShown] = useState(false);
	const menus = useLazy(loadMenus);
	const settingsModule = useLazy(loadSettings);
	const settingsButton = useRef<HTMLButtonElement>(null);
	const drawerId = useId();
	const settingsSeen = useRef(false);
	if (settingsOpen) settingsSeen.current = true;
	const closeSettings = useCallback(() => {
		setSettingsOpen(false);
		settingsButton.current?.focus();
	}, []);
	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), toastMilliseconds);
		return () => clearTimeout(timer);
	}, [toast]);
	const onToast = useCallback((text: string) => setToast({ text }), []);

	const school = schools.find((candidate) => candidate.id === route.schoolId);
	const schoolId = school?.id;
	/** Leaving a school ends its roster writes that are still pending: the Members tab of the school opened again reads
	 * the people afresh. A period or tab change inside the school keeps them. */
	useEffect(() => {
		setRosterChanges((kept) =>
			Object.keys(kept).every((keptSchoolId) => keptSchoolId === schoolId)
				? kept
				: schoolId !== undefined && kept[schoolId]
					? { [schoolId]: kept[schoolId] }
					: {},
		);
	}, [schoolId]);
	const [loadedDisclosure, setLoadedDisclosure] = useState<Disclosure | null>(
		null,
	);
	useEffect(() => {
		if (!schoolId) return;
		let current = true;
		reader.disclosure(schoolId).then((disclosure) => {
			if (current) setLoadedDisclosure(disclosure);
		}, keepLoading);
		return () => {
			current = false;
		};
	}, [reader, schoolId]);
	const disclosure =
		loadedDisclosure?.school === schoolId ? loadedDisclosure : null;
	const asked = route.query.get("as");
	const viewing = useMemo(
		() =>
			menus && disclosure ? menus.resolveViewing(disclosure, asked) : null,
		[menus, disclosure, asked],
	);
	const period = snapPeriod(
		parsePeriod(route.query.get("month"), clock.today),
		viewing?.view ?? null,
	);
	const theme = themeOf(route.query);

	const ready = Boolean(menus && settingsModule && (!school || viewing));
	/** Every school tab's pane reports its own render once its data is on screen. */
	const paneReports = Boolean(school && paneName);
	useLayoutEffect(() => {
		if (ready && !paneReports) onRendered();
	});

	/** Each school's last tab, in memory only (mockup `s.last`): switching school, or leaving All schools, returns to
	 * it, or to Plans for a school not opened yet. A school switch ends a preview. */
	const lastTabs = useRef<Record<string, SchoolTab>>({});
	const shownTab = route.tab;
	useEffect(() => {
		if (school && shownTab !== allSchools)
			lastTabs.current[school.id] = shownTab;
	}, [school, shownTab]);

	/** Another school opens as its own signed-in person, on its own Dashboard view, period and preset (mockup
	 * `setSchool`): only the theme carries over. */
	const chooseSchool = (chosen: string): void => {
		const query = new URLSearchParams();
		const themeAsked = route.query.get("theme");
		if (themeAsked) query.set("theme", themeAsked);
		if (chosen === allSchools)
			navigate({ schoolId: chosen, tab: allSchools, query });
		else
			navigate({
				schoolId: chosen,
				tab: lastTabs.current[chosen] ?? "plans",
				query,
			});
	};
	const chooseTab = (tab: SchoolTab): void => navigate({ ...route, tab });
	/** The tabs pattern: arrows, Home and End move to a tab and open it. */
	const onTabKeyDown = (
		event: JSX.TargetedKeyboardEvent<HTMLDivElement>,
	): void => {
		const index = (schoolTabs as readonly string[]).indexOf(route.tab);
		const targets: Record<string, number> = {
			ArrowLeft: (index + schoolTabs.length - 1) % schoolTabs.length,
			ArrowRight: (index + 1) % schoolTabs.length,
			Home: 0,
			End: schoolTabs.length - 1,
		};
		const target = schoolTabs[targets[event.key] ?? -1];
		if (!target) return;
		event.preventDefault();
		event.currentTarget
			.querySelector<HTMLElement>(`[data-tab=${target}]`)
			?.focus();
		chooseTab(target);
	};

	return (
		<>
			<TopBar
				route={route}
				schools={schools}
				school={school}
				clock={clock}
				period={period}
				menus={menus}
				viewing={viewing}
				inert={settingsOpen || portalShown}
				drawerId={drawerId}
				settingsOpen={settingsOpen}
				settingsButton={settingsButton}
				navigate={navigate}
				onChooseSchool={chooseSchool}
				onToggleSettings={() => setSettingsOpen(!settingsOpen)}
				onToast={onToast}
			/>
			{school && (
				<div
					class="tabs"
					inert={settingsOpen || portalShown}
					role="tablist"
					aria-label={school.name}
					onKeyDown={onTabKeyDown}
				>
					{schoolTabs.map((tab) => {
						const selected = tab === route.tab;
						const planSession = planSessions[school.id];
						const badge = tabBadge(
							tab,
							school,
							/* A session exists only once the panes have loaded, which is what can tell its draft from the live menu. */
							planSession && panes
								? panes.plansDraftChanged(planSession)
								: school.tabBadges.plansDraft,
						);
						return (
							<button
								key={tab}
								type="button"
								role="tab"
								class="tab"
								aria-label={
									badge ? `${tabs[tab].label}: ${badge.meaning}` : undefined
								}
								id={`tab-${tab}`}
								data-test="tab"
								data-tab={tab}
								aria-selected={selected}
								aria-controls={selected ? "pane" : undefined}
								tabIndex={selected ? 0 : -1}
								onClick={() => chooseTab(tab)}
							>
								<CoreIcon name={tabs[tab].icon} />
								{tabs[tab].label}
								{badge && (
									<span class={`badge ${badge.tone}`} data-test="tab-badge">
										{badge.text}
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}
			{school && menus && viewing?.preview && (
				<menus.PreviewBanner
					viewing={viewing}
					inert={settingsOpen || portalShown}
					onExit={() => navigate(withQuery(route, "as", null))}
				/>
			)}
			{school?.stale && (
				<div
					class="banner"
					data-test="stale-banner"
					inert={settingsOpen || portalShown}
				>
					<CoreIcon name="alert" /> Data is {school.lagMinutes} min behind: the
					shipper may be stuck. Recent events can be missing.
				</div>
			)}
			<section
				class="pane on"
				inert={settingsOpen}
				id="pane"
				data-test="pane"
				role={school ? "tabpanel" : undefined}
				aria-labelledby={school ? `tab-${route.tab}` : undefined}
				aria-label={school ? undefined : "All schools"}
			>
				<ViewingContext.Provider value={viewing}>
					{ready && school && panes && paneName && (
						<panes.Pane
							key={school.id}
							name={paneName}
							reader={reader}
							writer={writer}
							school={school}
							clock={clock}
							route={route}
							navigate={navigate}
							onRendered={onRendered}
							onToast={onToast}
							session={planSessions[school.id]}
							onSession={keepPlanSession}
							pendingBookings={pendingBookings[school.id] ?? noPendingBookings}
							onPendingBookings={keepPendingBookings}
							membershipChanges={
								membershipChanges[school.id] ?? noMembershipChanges
							}
							onMembershipChanges={keepMembershipChanges}
							rosterChanges={rosterChanges[school.id] ?? noRosterChanges}
							onRosterChanges={keepRosterChanges}
							audienceMoves={audienceMoves[school.id] ?? noAudienceMoves}
							onAudienceMoves={keepAudienceMoves}
							onOpenSettings={() => setSettingsOpen(true)}
							onShownChange={setPortalShown}
						/>
					)}
				</ViewingContext.Provider>
			</section>
			<SettingsDrawer
				id={drawerId}
				open={settingsOpen}
				dialogOpen={modal !== null}
				subtitle={school ? `You and ${school.name}` : "All schools"}
				theme={theme}
				onThemeChange={(chosen) =>
					navigate(
						withQuery(route, "theme", chosen === "system" ? null : chosen),
					)
				}
				onClose={closeSettings}
			>
				{settingsModule && settingsSeen.current && !school && (
					<settingsModule.AllSchoolsNote />
				)}
				{settingsModule && settingsSeen.current && school && viewing && (
					<settingsModule.SchoolSettings
						key={school.id}
						reader={reader}
						writer={writer}
						school={school}
						viewing={viewing}
						onToast={onToast}
						onModal={setModal}
					/>
				)}
			</SettingsDrawer>
			{modal !== null && <DialogSlot>{modal}</DialogSlot>}
			<div
				class={toast ? "toast on" : "toast"}
				data-test={toast || !membersOpen ? "toast" : undefined}
				aria-live="polite"
			>
				{toast?.text}
			</div>
		</>
	);
}
