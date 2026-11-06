import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type {
	AudienceView,
	Disclosure,
	ViewAsOption,
} from "../data/disclosure.ts";
import { type Period, parsePeriod, snapPeriod } from "./period.ts";

/** What the route views (`as=`, resolved by `resolveViewAs`): the school's disclosure, the View as row chosen and the
 * audience view it shows. In a preview (`preview`) the banner shows and every write control is disabled. The shell
 * provides it to the panes once the disclosure has loaded; a gated surface shows `option.locks[surface]`. */
export type Viewing = {
	disclosure: Disclosure;
	option: ViewAsOption;
	preview: boolean;
	view: AudienceView;
};

export const ViewingContext = createContext<Viewing | null>(null);

export function useViewing(): Viewing {
	const viewing = useContext(ViewingContext);
	if (!viewing) throw new Error("no school is being viewed");
	return viewing;
}

/** The money period a pane shows (mockup `P` after `snapP`): the route's `month=` (or `fallback` when it has none),
 * moved to the last period the viewed audience may see when its grain or delay hides the asked one. Every pane's
 * period label reads this, so the label names what the audience sees: "Q2 2026" for a Member in November. */
export function useViewedPeriod(
	asked: string | null,
	today: string,
	fallback: string | null = null,
): Period {
	const { view } = useViewing();
	return snapPeriod(parsePeriod(asked ?? fallback, today), view);
}

/** The name of the viewer's own View as row ("Owner", "Finance admin", "Admin"). */
export const ownRowName = ({ viewAs, viewer }: Disclosure): string =>
	viewAs.find(({ value }) => value === viewer.viewAs)?.name ?? "";

/** The title of a write control while previewing. */
export const exitPreviewTitle = "Exit preview to act";
