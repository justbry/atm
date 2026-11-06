import "./panes.css";
import type { ComponentType, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { BooksPaneProps } from "./books-pane.ts";
import type { AudienceMove, PlansSession } from "./plans-menu.ts";
import type { Change } from "./portal-format.ts";
import type { SchoolTab } from "./route.ts";

/** Everything a pane may be given; each takes the props it names. */
export type PaneProps = BooksPaneProps & {
	/** Plans: the school's draft kept by the shell, and where a changed one goes. */
	session: PlansSession | undefined;
	onSession: (schoolId: string, session: PlansSession) => void;
	onOpenSettings: () => void;
	/** The bookings this school has had an outcome or a release written for, kept by the shell: Bookings and Members
	 * both show them as on their way until the ledger ships, whichever tab wrote them. */
	pendingBookings: ReadonlySet<string>;
	onPendingBookings: (
		schoolId: string,
		update: (before: ReadonlySet<string>) => ReadonlySet<string>,
	) => void;
	/** The member portal's membership changes (Change amount, Cancel membership, Resume) that are on their way or made, by
	 * profile id: the shell keeps them so that leaving the portal and opening it again does not give back a button whose
	 * write was already sent. */
	membershipChanges: Record<string, Change>;
	onMembershipChanges: (
		schoolId: string,
		update: (before: Record<string, Change>) => Record<string, Change>,
	) => void;
	/** The tiers of this school a publish gave another audience, by tier id: the shell keeps them so that the member
	 * portal reads the new audience, with a notice, until the Reader says it. */
	audienceMoves: Record<string, AudienceMove>;
	onAudienceMoves: (
		schoolId: string,
		moves: Record<string, AudienceMove>,
	) => void;
	/** The member portal covers the page while it is shown. */
	onShownChange: (shown: boolean) => void;
};
/** A tab's pane, or the member portal, which takes the Members pane while the route has `portal=`. */
export type PaneName = SchoolTab | "portal";

/** Each pane, loaded the first time it is shown. This table is itself loaded on demand, so the first page load
 * carries none of the panes' chunk lists. */
const paneLoaders: Record<PaneName, () => Promise<ComponentType<PaneProps>>> = {
	plans: () => import("./plans.tsx").then((module) => module.Plans),
	dashboard: () => import("./dashboard.tsx").then((module) => module.Dashboard),
	members: () => import("./members.tsx").then((module) => module.Members),
	portal: () => import("./portal.tsx").then((module) => module.PortalPane),
	bookings: () => import("./bookings.tsx").then((module) => module.Bookings),
	promos: () => import("./promos.tsx").then((module) => module.Promos),
	ledger: () => import("./ledger.tsx").then((module) => module.Ledger),
	reports: () => import("./reports.tsx").then((module) => module.Reports),
};

/** The pane `name` names, once its module has loaded. */
export function Pane({
	name,
	...props
}: PaneProps & { name: PaneName }): JSX.Element | null {
	const [panes, setPanes] = useState<
		Partial<Record<PaneName, ComponentType<PaneProps>>>
	>({});
	const Shown = panes[name];
	useEffect(() => {
		if (!Shown)
			paneLoaders[name]().then((loaded) =>
				setPanes((before) => ({ ...before, [name]: loaded })),
			);
	}, [name, Shown]);
	return Shown ? <Shown {...props} /> : null;
}
