import { Fragment, type JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import type { Bookings } from "./bookings.tsx";
import type { Dashboard } from "./dashboard.tsx";
import { Icon, type IconName } from "./icon.tsx";
import type { Members } from "./members.tsx";
import { formatPeriod, parsePeriod } from "./period.ts";
import { PeriodControl } from "./period-control.tsx";
import type { Plans } from "./plans.tsx";
import type { PlansSession } from "./plans-menu.ts";
import { Popover } from "./popover.tsx";
import {
	allSchools,
	type Route,
	type SchoolTab,
	schoolTabs,
	themeOf,
	withQuery,
} from "./route.ts";
import { SchoolSwitcher } from "./school-switcher.tsx";
import { SettingsDrawer } from "./settings-drawer.tsx";

const toastMilliseconds = 4600;
const tabs: Record<SchoolTab, { label: string; icon: IconName }> = {
	plans: { label: "Plans", icon: "layers" },
	dashboard: { label: "Dashboard", icon: "chart" },
	members: { label: "Members", icon: "users" },
	bookings: { label: "Bookings", icon: "calendar" },
	promos: { label: "Promos", icon: "tag" },
	ledger: { label: "Ledger", icon: "list" },
	reports: { label: "Reports", icon: "chart" },
};
const assistantPrompt = [
	"You are helping an owner or admin of a school on atm, the bookings and payments service behind ledger.b4uni.com.",
	"Treat this as read-only context: you can read what I paste from the ledger, and nothing you say changes plans, bookings, promos or payments.",
	"The ledger is an append-only list of events; reports come from it through hledger and DuckDB, and apps use the School SDK, @b4uni/school.",
	"When you are not sure what an event means, say so and point me to the ledger event reference.",
].join(" ");
const copyFailedToast =
	"Could not copy the prompt: the browser blocked the clipboard.";
const helpLinks: Array<{
	label: string;
	detail?: string;
	icon: IconName;
	toast: string;
	/** Text the link puts on the clipboard before its toast. */
	copy?: string;
}> = [
	{
		label: "School SDK",
		detail: "@b4uni/school",
		icon: "box",
		toast: "Opening the School SDK readme…",
	},
	{
		label: "Ledger event reference",
		icon: "list",
		toast: "Opening the event reference…",
	},
	{
		label: "Reports with hledger and DuckDB",
		icon: "chart",
		toast: "Opening the recipes…",
	},
	{
		label: "Copy a prompt for an AI assistant",
		icon: "copy",
		toast: "Prompt copied. It gives an assistant read-only context.",
		copy: assistantPrompt,
	},
];

const counted = (count: number, noun: string): string =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** A tab's badge from the school's counts (mockup `#plbadge`, `#bkbadge`, `#pbadge`), or null when it has none.
 * `meaning` is what a screen reader hears for the badge. */
function tabBadge(
	tab: SchoolTab,
	{ tabBadges }: School,
): { text: string; meaning: string; tone: "b-warn" | "b-bad" } | null {
	const { plansDraft, bookingsOverdue, promosExpiring } = tabBadges;
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

/** The mockup's frame (lines 261 to 282): top bar with the scope note, tabs row, stale banner, the current tab's pane, the settings
 * drawer and the toast. The Dashboard, Bookings, Plans and Members fill their panes; later slices fill the others. The Members golden file counts the toast only while it shows, and S2's test reads it empty, so the toast carries its hook while empty on every tab but Members. While the drawer is open the regions
 * behind it are inert; the toast stays out of that so it can still be announced. */
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
	/** The Dashboard pane, loaded the first time its tab opens so that the first page load stays small. */
	const [DashboardPane, setDashboardPane] = useState<typeof Dashboard | null>(
		null,
	);
	const dashboardOpen = route.tab === "dashboard";
	useEffect(() => {
		if (dashboardOpen && !DashboardPane)
			import("./dashboard.tsx").then((module) =>
				setDashboardPane(() => module.Dashboard),
			);
	}, [dashboardOpen, DashboardPane]);
	/** The Bookings pane, loaded the same way. */
	const [BookingsPane, setBookingsPane] = useState<typeof Bookings | null>(
		null,
	);
	const bookingsOpen = route.tab === "bookings";
	useEffect(() => {
		if (bookingsOpen && !BookingsPane)
			import("./bookings.tsx").then((module) =>
				setBookingsPane(() => module.Bookings),
			);
	}, [bookingsOpen, BookingsPane]);
	/** The Plans pane, loaded the same way. */
	const [PlansPane, setPlansPane] = useState<typeof Plans | null>(null);
	const plansOpen = route.tab === "plans";
	useEffect(() => {
		if (plansOpen && !PlansPane)
			import("./plans.tsx").then((module) => setPlansPane(() => module.Plans));
	}, [plansOpen, PlansPane]);
	/** Each school's plans and draft, kept for the life of the mount: leaving the tab keeps an unsaved draft, and the
	 * Plans tab's badge follows the draft. */
	const [planSessions, setPlanSessions] = useState<
		Record<string, PlansSession>
	>({});
	const keepPlanSession = useCallback(
		(schoolId: string, session: PlansSession) =>
			setPlanSessions((kept) => ({ ...kept, [schoolId]: session })),
		[],
	);
	/** The Members pane, loaded the same way. */
	const [MembersPane, setMembersPane] = useState<typeof Members | null>(null);
	const membersOpen = route.tab === "members";
	useEffect(() => {
		if (membersOpen && !MembersPane)
			import("./members.tsx").then((module) =>
				setMembersPane(() => module.Members),
			);
	}, [membersOpen, MembersPane]);
	const settingsButton = useRef<HTMLButtonElement>(null);
	const drawerId = useId();
	const closeSettings = useCallback(() => {
		setSettingsOpen(false);
		settingsButton.current?.focus();
	}, []);
	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), toastMilliseconds);
		return () => clearTimeout(timer);
	}, [toast]);

	const school = schools.find((candidate) => candidate.id === route.schoolId);
	const period = parsePeriod(route.query.get("month"), clock.today);
	const theme = themeOf(route.query);
	const periodShown =
		!school || route.tab === "ledger" || route.tab === "reports";

	/** Each school's last tab, in memory only (mockup `s.last`): switching school, or leaving All schools, returns to
	 * it, or to Plans for a school not opened yet. */
	const lastTabs = useRef<Record<string, SchoolTab>>({});
	const shownTab = route.tab;
	useEffect(() => {
		if (school && shownTab !== allSchools)
			lastTabs.current[school.id] = shownTab;
	}, [school, shownTab]);

	const chooseSchool = (schoolId: string): void => {
		const query = withQuery(route, "member", null).query;
		if (schoolId === allSchools) navigate({ schoolId, tab: allSchools, query });
		else
			navigate({
				schoolId,
				tab: lastTabs.current[schoolId] ?? "plans",
				query,
			});
	};
	/** Shows the link's toast; a link that copies says so only once the clipboard has taken the text. */
	const followHelpLink = async (
		link: (typeof helpLinks)[number],
	): Promise<void> => {
		if (!link.copy) {
			setToast({ text: link.toast });
			return;
		}
		try {
			await navigator.clipboard.writeText(link.copy);
			setToast({ text: link.toast });
		} catch {
			setToast({ text: copyFailedToast });
		}
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
			<div class="top" inert={settingsOpen}>
				<span class="logo" data-test="brand">
					atm
				</span>
				<SchoolSwitcher
					schools={schools}
					current={route.schoolId}
					onChoose={chooseSchool}
				/>
				{school && (
					<span
						class="kview"
						data-test="scope-note"
						title={`You are ${school.role === "owner" ? "an owner" : "an admin"} in ${school.name}. Owners and admins own the dashboard and see everyone's data. Members see only themselves and their family.`}
					>
						<Icon name="eye" />
						You see all members
					</span>
				)}
				<span class="sp" />
				<PeriodControl
					period={period}
					today={clock.today}
					shown={periodShown}
					timeZoneNote={
						school
							? `Times in ${school.timeZone}`
							: "Each school's own time zone"
					}
					onChoose={(chosen) =>
						navigate(
							withQuery(route, "month", formatPeriod(chosen, clock.today)),
						)
					}
				/>
				<Popover
					trigger={{
						class: "ib",
						"data-test": "help-button",
						title: "Help and SDK",
						"aria-label": "Help and SDK",
					}}
					alignRight
					label={<Icon name="help" />}
				>
					{(close) =>
						helpLinks.map((link, index) => (
							<Fragment key={link.label}>
								{index === helpLinks.length - 1 && <hr />}
								<button
									type="button"
									class="it"
									data-test="help-link"
									onClick={() => {
										close();
										followHelpLink(link);
									}}
								>
									<Icon name={link.icon} />
									<span class="sp2">{link.label}</span>
									{link.detail && <span class="mut">{link.detail}</span>}
								</button>
							</Fragment>
						))
					}
				</Popover>
				<button
					ref={settingsButton}
					type="button"
					class="ib"
					data-test="settings-button"
					title="Settings"
					aria-label="Settings"
					aria-haspopup="dialog"
					aria-controls={drawerId}
					aria-expanded={settingsOpen}
					onClick={() => setSettingsOpen(!settingsOpen)}
				>
					<Icon name="gear" />
				</button>
			</div>
			{school && (
				<div
					class="tabs"
					inert={settingsOpen}
					role="tablist"
					aria-label={school.name}
					onKeyDown={onTabKeyDown}
				>
					{schoolTabs.map((tab) => {
						const selected = tab === route.tab;
						const badge = tabBadge(tab, {
							...school,
							tabBadges: {
								...school.tabBadges,
								plansDraft:
									planSessions[school.id]?.hasChanges ??
									school.tabBadges.plansDraft,
							},
						});
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
								<Icon name={tabs[tab].icon} />
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
			{school?.stale && (
				<div class="banner" data-test="stale-banner" inert={settingsOpen}>
					<Icon name="alert" /> Data is {school.lagMinutes} min behind: the
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
				{school && dashboardOpen && DashboardPane && (
					<DashboardPane
						reader={reader}
						school={school}
						route={route}
						navigate={navigate}
						onRendered={onRendered}
						onToast={(text) => setToast({ text })}
					/>
				)}
				{school && bookingsOpen && BookingsPane && (
					<BookingsPane
						key={school.id}
						reader={reader}
						writer={writer}
						school={school}
						clock={clock}
						route={route}
						navigate={navigate}
						onRendered={onRendered}
						onToast={(text) => setToast({ text })}
					/>
				)}
				{school && plansOpen && PlansPane && (
					<PlansPane
						key={school.id}
						reader={reader}
						writer={writer}
						school={school}
						route={route}
						navigate={navigate}
						session={planSessions[school.id]}
						onSession={keepPlanSession}
						onRendered={onRendered}
						onToast={(text) => setToast({ text })}
						onOpenSettings={() => setSettingsOpen(true)}
					/>
				)}
				{school && membersOpen && MembersPane && (
					<MembersPane
						key={school.id}
						reader={reader}
						writer={writer}
						school={school}
						clock={clock}
						route={route}
						navigate={navigate}
						onRendered={onRendered}
						onToast={(text) => setToast({ text })}
					/>
				)}
			</section>
			<SettingsDrawer
				id={drawerId}
				open={settingsOpen}
				subtitle={school ? `You and ${school.name}` : "All schools"}
				theme={theme}
				onThemeChange={(chosen) =>
					navigate(
						withQuery(route, "theme", chosen === "system" ? null : chosen),
					)
				}
				onClose={closeSettings}
			/>
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
