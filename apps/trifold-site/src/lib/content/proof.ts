/**
 * The proof the site shows, in one place: two verified simulator runs (copied verbatim from the engine's output), the
 * try-it commands, the scenario knobs, and the golden end-to-end check with its findings. /proof, the homepage,
 * /for/developers and llms.txt all read from here, so a number can't differ between pages.
 *
 * The outputs say "atm" because that is the CLI's name until the rename to tfd lands. Keep them verbatim.
 */
import { GITHUB_URL } from "#lib/config";
import { SEED_7_HASH } from "./proof-summary";

export * from "./proof-summary";

const REPO_FILE = `${GITHUB_URL}/blob/dev/packages/atm`;

export const SEED_7_COMMAND =
	"bun ./src/bin.ts simulate --profile growth-12mo --seed 7";
export const SEED_7_LINES = [
	`$ ${SEED_7_COMMAND}`,
	"scenario growth-12mo (seed 7): 1964 events, 2026-01..2026-12",
	"fixture hash c5e322c7d39c63fd44c4a61d4bcb88eb92bf5ca26f7f3e6a9cff3a7cc59186af",
	"kpis hash by channel:",
	`  atm      ${SEED_7_HASH}`,
	`  hledger  ${SEED_7_HASH}`,
	`  duckdb   ${SEED_7_HASH}`,
	"parity: every channel that ran has the same hash",
];

export const SEED_42_COMMAND =
	"bun ./src/bin.ts simulate --profile monthly-members --set members=120 --set churnRate=0.05 --set refundRate=0.08 --set yearlyShare=0.3 --seed 42";
export const SEED_42_LINES = [
	`$ ${SEED_42_COMMAND}`,
	"scenario monthly-members (seed 42): 5794 events, 2026-01..2026-12",
	"fixture hash 88662ef16ad63f969d8984bcb2743071513ef4d5fbee0ca063612351388b1e5e",
	"kpis hash by channel:",
	"  atm      2de5997d9be71c3d3c099217459fe251b24bdfe1f5f852a6e8b778f58c1b4b27",
	"  hledger  2de5997d9be71c3d3c099217459fe251b24bdfe1f5f852a6e8b778f58c1b4b27",
	"  duckdb   2de5997d9be71c3d3c099217459fe251b24bdfe1f5f852a6e8b778f58c1b4b27",
	"parity: every channel that ran has the same hash",
];

/** Clone, install, run. `bun install` installs the whole monorepo workspace, not only the engine. */
export const TRY_IT_LINES = [
	`$ git clone ${GITHUB_URL} && cd atm && bun install`,
	`$ cd packages/atm && ${SEED_7_COMMAND}`,
];
export const TRY_IT_NOTE =
	"It needs bun. bun install sets up the whole monorepo workspace, not just the engine. hledger and DuckDB are optional: a channel that isn't installed is skipped, which is why the last line says “every channel that ran”.";

/** The knobs in packages/atm/src/scenario/params.ts, in plain words. */
export const KNOBS: { name: string; what: string }[] = [
	{ name: "months", what: "months simulated, 1 to 36" },
	{ name: "start", what: "the first month, YYYY-MM" },
	{ name: "members", what: "families that join in month one, 0 to 200" },
	{
		name: "newMembersPerMonth",
		what: "families that join each later month, 0 to 50",
	},
	{ name: "tierMix", what: "how new families pick among the tiers" },
	{ name: "yearlyShare", what: "the share of families that pay yearly" },
	{ name: "addonRate", what: "the chance a family buys an add-on at sign-up" },
	{
		name: "freeShare",
		what: "the share whose invoices are fully discounted: credits, no money",
	},
	{ name: "churnRate", what: "the chance a family cancels at a renewal" },
	{ name: "refundRate", what: "the chance a paid invoice is refunded" },
	{ name: "partialRefundShare", what: "the share of refunds that are partial" },
	{ name: "disputeRate", what: "the chance a paid invoice is disputed" },
	{
		name: "disputeLostShare",
		what: "the share of closed disputes that are lost",
	},
	{
		name: "usageRate",
		what: "how often a family books a class with its credits",
	},
	{ name: "currency", what: "usd, eur, gbp or cad" },
	{ name: "feePercent", what: "Stripe's percentage fee on a payment" },
	{ name: "feeFixedCents", what: "Stripe's fixed fee on a payment, in cents" },
	{
		name: "seatChangeRate",
		what: "the monthly chance a seat count moves up or down (default 0)",
	},
	{
		name: "upgradeRate",
		what: "the monthly chance a monthly plan moves up a tier (default 0)",
	},
];
export const PRESETS_COMMAND = "bun ./src/bin.ts scenarios list";
/** The school's presets; the other orgs' presets live in src/lib/verticals.ts. */
export const PRESETS = [
	"free-only",
	"monthly-members",
	"annual-prepay",
	"heavy-refunds",
	"disputes",
];

/** Verified commands for the org scenarios, run from packages/atm. */
export const SIM_COMMANDS = [
	"$ bun ./src/bin.ts scenarios list",
	"$ bun ./src/bin.ts scenarios describe church-giving",
	"$ bun ./src/bin.ts simulate --profile saas-seats --json",
];
/** An ad-hoc scenario for one org, from stdin. */
export const ADHOC_COMMAND = `echo '{"org":"creator","params":{"members":40,"refundRate":0.1}}' | bun ./src/bin.ts simulate --scenario - --json`;

export const PARAMS_URL = `${REPO_FILE}/src/scenario/params.ts`;
export const GOLDEN_DOC_URL = `${REPO_FILE}/docs/golden-e2e-check.md`;
export const GOLDEN_TEST_URL = `${REPO_FILE}/tests/golden-e2e-check.test.ts`;
/** The run the numbers below come from. */
export const GOLDEN_RUN_DATE = "2026-11-05";

/** What the golden end-to-end check does, from the full run recorded on GOLDEN_RUN_DATE. */
export const GOLDEN_STEPS: { title: string; text: string }[] = [
	{
		title: "The real CLI",
		text: "Each command runs as its own process, the way you'd run it, over 46 scenario bundles and two generated school years. The bundles' Stripe events are hand-written from Stripe's documented shapes or recorded in a Stripe sandbox.",
	},
	{
		title: "Byte for byte",
		text: "Every output is compared byte for byte with goldens committed to the repo, and hledger's own checks run on the journals.",
	},
	{
		title: "Crash drill",
		text: "The commands that ship records to the folder are killed with SIGKILL mid-operation, then run again. 72 trials; in 62 the kill landed mid-operation. All 72 reruns were identical to an uninterrupted run.",
	},
	{
		title: "Time zones",
		text: "The whole check runs again under America/Denver and Asia/Tokyo. The output is byte-identical to the goldens under both.",
	},
	{
		title: "Read-only means read-only",
		text: "The database and the folder are hashed before and after every read-only command, to show nothing changed.",
	},
	{
		title: "Erasure drill",
		text: "After a family is erased, its personal strings are searched for in every file and every table.",
	},
];

/** What the check found. Each finding is pinned in the test, which fails when one appears or goes away. */
export const FINDINGS: { id: string; title: string; text: string }[] = [
	{
		id: "F1",
		title: "A what-if from the folder can be less complete",
		text: "When the history holds a refused invoice, a what-if run from the shipped folder is less complete than one from the database. It shows up in 2 of the 46 bundles. No money is involved.",
	},
	{
		id: "F2",
		title: "Erased facts linger until a checkpoint",
		text: "After an erasure, the erased facts (ids, amounts, times) stay in SQLite's write-ahead log until the next checkpoint. Never names or emails, which are never stored.",
	},
	{
		id: "F3",
		title: "The first ship of a large backlog is slow",
		text: "Shipping a very large backlog for the first time is slow. We've identified an index fix.",
	},
	{
		id: "F4",
		title: "What-if memory grows with history",
		text: "A what-if run's memory grows with the size of the history: about 2 GB for a year of 1,000 families.",
	},
];
export const FINDINGS_PINNED =
	"Each finding is pinned in the test. It fails when a new one appears or a known one goes away, so this list can't quietly go stale.";

export const DOESNT_PROVE = [
	"These are fixtures and simulations, not a real organization's data. The Stripe events are hand-written from Stripe's documented shapes or recorded in a sandbox; a live account can still do something we haven't seen.",
	"Matching hashes show three tools agree on the same events. They don't show the events match what happened at the bank.",
	"A simulation is a model of an organization, not a forecast of yours.",
];
