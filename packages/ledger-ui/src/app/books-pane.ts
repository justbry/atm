import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import type { Route } from "./route.ts";

/** What the Ledger, Reports and Promos panes are given. `onRendered` is called after each render that shows what the
 * route asks for (data, or a lock panel). */
export type BooksPaneProps = {
	reader: Reader;
	writer: Writer;
	school: School;
	clock: Clock;
	route: Route;
	navigate: (route: Route) => void;
	onRendered: () => void;
	onToast: (text: string) => void;
};

/** cell-rules `minContributors`: a count under this shows as `<10` (a figure from 1 to 4 is never shown as it is). */
export const smallCount = 5;

/** The lock panel heading of an identified surface (the Ledger, the full statement, the donors table). */
export const identitiesLockHeading = "Finance admins and the owner see this";
