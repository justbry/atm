import type { School } from "../data/types.ts";

/** The mockup's View as choices (`SUBS`): who the pane is drawn for. `finance` is an admin with the finance grant. */
const viewAsChoices = [
	"owner",
	"finance",
	"admin",
	"governance",
	"member",
	"public",
] as const;
type ViewAs = (typeof viewAsChoices)[number];

/** The title of every write control while another audience than your own is shown (mockup `pvLock`). */
export const exitPreviewTitle = "Exit preview to act";

/** What a pane needs of the audience it is drawn for. */
export type AudienceView = {
	audience: ViewAs;
	/** The audience is not the signed-in person's own: writes are off. */
	preview: boolean;
	/** Owner, finance admin or admin: sees the draft, Get started and the strip. */
	admin: boolean;
	/** Owner or finance admin: sees every figure. */
	finance: boolean;
};

type OwnAudience = "owner" | "finance" | "admin";

const isViewAs = (value: string | null): value is ViewAs =>
	viewAsChoices.some((choice) => choice === value);

/** The signed-in person's own audience (mockup `youSub`): the owner, a finance admin or an admin. */
function ownAudience(school: School): OwnAudience {
	if (school.role === "owner") return "owner";
	return school.booksLevel === "finance_admin" ? "finance" : "admin";
}

/** Mockup `vaAllowed`: owner and finance only by the owner, admin by the owner or a finance admin, governance, member
 * and public by anyone who holds that audience (an admin holds member and public). */
function mayPreview(you: OwnAudience, asked: ViewAs): boolean {
	if (asked === you) return true;
	if (asked === "owner" || asked === "finance") return you === "owner";
	if (asked === "admin") return you === "owner" || you === "finance";
	return you !== "admin" || asked !== "governance";
}

/** The audience a pane is drawn for: the route's `as=` when the person may preview it, else their own. */
export function audienceView(
	school: School,
	asked: string | null,
): AudienceView {
	const you = ownAudience(school);
	const audience = isViewAs(asked) && mayPreview(you, asked) ? asked : you;
	return {
		audience,
		preview: audience !== you,
		admin:
			audience === "owner" || audience === "finance" || audience === "admin",
		finance: audience === "owner" || audience === "finance",
	};
}
