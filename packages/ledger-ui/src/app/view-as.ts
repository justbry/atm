import type { BooksLevel } from "../data/kpi-document.ts";
import type { School } from "../data/types.ts";

/** The audiences a person can preview (mockup `SUBS`), highest first. */
const audiences = [
	"owner",
	"finance",
	"admin",
	"governance",
	"member",
	"public",
] as const;
type Audience = (typeof audiences)[number];

const booksRank: Record<BooksLevel, number> = {
	public: 0,
	member: 1,
	governance: 2,
	finance_admin: 3,
	owner: 4,
};

/** The audience the signed-in person is (mockup `youSub`): the owner, a finance admin, or an admin. */
function ownAudience({ role, booksLevel }: School): Audience {
	if (role === "owner") return "owner";
	return booksRank[booksLevel] >= booksRank.finance_admin ? "finance" : "admin";
}

/** Mockup `vaAllowed`: the owner and finance audiences only the owner may preview, admin the owner or a finance admin,
 * and governance, member and public anyone whose books level reaches that audience. */
function mayPreview(school: School, audience: Audience): boolean {
	const own = ownAudience(school);
	if (audience === own) return true;
	if (audience === "owner" || audience === "finance") return own === "owner";
	if (audience === "admin") return own === "owner" || own === "finance";
	return booksRank[audience] <= booksRank[school.booksLevel];
}

/** The audience the hash's `as=` shows (mockup `VW`): the one asked for if the person may preview it, else their
 * own. */
export function viewedAudience(
	school: School,
	requested: string | null,
): Audience {
	const asked = audiences.find((audience) => audience === requested);
	return asked && mayPreview(school, asked) ? asked : ownAudience(school);
}
