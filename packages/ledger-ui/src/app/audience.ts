import type { BooksLevel } from "../data/kpi-document.ts";
import type { PortalAudience } from "../data/portal.ts";
import type { School } from "../data/types.ts";

/** The five audiences of school books in rank order, widest first. */
const audiences: readonly PortalAudience[] = [
	"public",
	"member",
	"governance",
	"finance",
	"owner",
];
const audienceOfLevel: Record<BooksLevel, PortalAudience> = {
	public: "public",
	member: "member",
	governance: "governance",
	finance_admin: "finance",
	owner: "owner",
};
const rankOf = (audience: PortalAudience): number =>
	audiences.indexOf(audience);

/** The audience the page is read as (the shared `as=` parameter): the signed-in person's own, or any at or below it.
 * `preview` says it is not their own, so every write is off (mockup `pvLock`). */
type Viewing = { audience: PortalAudience; preview: boolean };

export function viewingOf(query: URLSearchParams, school: School): Viewing {
	const own = audienceOfLevel[school.booksLevel];
	const asked = audiences.find((audience) => audience === query.get("as"));
	const audience = asked && rankOf(asked) <= rankOf(own) ? asked : own;
	return { audience, preview: audience !== own };
}

/** Owners and admins see the roster and open a member's portal; every audience below finance sees neither. */
export const seesRoster = (audience: PortalAudience): boolean =>
	audience === "finance" || audience === "owner";
