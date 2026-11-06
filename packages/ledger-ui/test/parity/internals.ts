/**
 * What stands for the mockup's internals (`window.__t`) on the UI side: the UI's own exported functions and the
 * fixture Reader's data, only where the UI has an honest counterpart. map.json's `internals` names, for each
 * `window.__t.<name>`, the shim below that provides it, or null when there is none (the name is then absent and the
 * checks that need it do not run; checks.json says why). No shim re-implements mockup logic: each reads the Reader or
 * calls the UI's function and only renames fields or adapts the call shape.
 *
 * `SC` is a snapshot of the Reader's data at mount, one record per school, holding only what has a counterpart:
 * `name`, `timeZone`, `stripe` and `pl` ({pub, draft, version}, as plans.tsx loads them), `R` (owners and admins),
 * `people` and `capabilities` (Members), `M` ([id, name] per person, the handle the history checks pass around) and
 * `disclosure`. Reading any other field (the mockup's event log `E`, its stored override `discO`, ...) throws, so no
 * check passes on a field the UI does not have. A check that reads SC after an interaction does not see what the UI
 * did; checks.json marks those.
 */

import { type RoleChange, roleGuard } from "../../src/app/members-model.ts";
import { emptyMenu } from "../../src/app/plans-menu.ts";
import { emitMenu, parseMenu } from "../../src/app/plans-yaml.ts";
import { parseRoute } from "../../src/app/route.ts";
import {
	type Disclosure,
	resolveViewAs,
	type ViewAs,
} from "../../src/data/disclosure.ts";
import {
	type HistoryCsvRow,
	historyColumns,
	toCsv,
} from "../../src/data/ledger.ts";
import type { Capabilities, Person } from "../../src/data/members.ts";
import type { Menu, MenuVersionBody } from "../../src/data/plans.ts";
import {
	type HistoryPeriod,
	historyRowsIn,
	type MemberPortal,
	type PortalHistoryRow,
	paymentStatusLabels,
} from "../../src/data/portal.ts";
import type { Reader } from "../../src/data/reader.ts";
import { membersFixtures } from "../../src/fixtures/members.ts";

export type Shims = Record<
	string,
	(reader: Reader) => Promise<unknown> | unknown
>;

/** The adapter's clock, which the fixture Reader and the mounted UI run at. */
const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const clone = <Value>(value: Value): Value =>
	JSON.parse(JSON.stringify(value)) as Value;

type RoleHolder = Pick<Person, "id" | "name" | "role"> & Partial<Person>;
type School = {
	id: string;
	name: string;
	timeZone: string;
	stripe: MenuVersionBody["stripe"];
	pl: { pub: Menu; draft: Menu; version: number };
	disclosure: Disclosure;
	R?: RoleHolder[];
	people?: Person[];
	capabilities?: Capabilities;
	M?: Array<[string, string]>;
};

const strict = (school: School): School =>
	new Proxy(school, {
		get(target, key, receiver) {
			if (typeof key === "symbol" || key in target)
				return Reflect.get(target, key, receiver);
			throw new Error(
				`T.SC.${target.id}.${String(key)}: the mockup's school record has no UI counterpart for this field`,
			);
		},
	});

const noStripe: MenuVersionBody["stripe"] = {
	products: [],
	prices: [],
	portal: false,
};

/** `SC`: every school the Reader serves. */
async function schoolsOf(reader: Reader): Promise<Record<string, School>> {
	const out: Record<string, School> = {};
	for (const school of await reader.schools()) {
		const [{ versions }, summary, disclosure] = await Promise.all([
			reader.menuVersions(school.id),
			reader.planSummary(school.id),
			reader.disclosure(school.id),
		]);
		const published = versions.find(({ publishedAt }) => publishedAt !== null);
		const newest = versions[0];
		const saved = newest && newest.publishedAt === null ? newest : undefined;
		const liveBody = published
			? await reader.menuVersion(school.id, published.version)
			: undefined;
		const draftBody = saved
			? await reader.menuVersion(school.id, saved.version)
			: undefined;
		const pub =
			liveBody?.menu ??
			emptyMenu(school.currency, school.timeZone, summary.features);
		const record: School = {
			id: school.id,
			name: school.name,
			timeZone: school.timeZone,
			stripe: liveBody?.stripe ?? noStripe,
			pl: {
				pub,
				draft: clone(draftBody?.menu ?? pub),
				version: liveBody?.version ?? 0,
			},
			disclosure,
		};
		if (school.id in membersFixtures) {
			const people = await reader.people({ schoolId: school.id });
			record.people = people;
			record.R = people.filter(({ role }) => role !== "member");
			record.capabilities = await reader.capabilities({ schoolId: school.id });
			record.M = people.map((person): [string, string] => [
				person.id,
				person.name,
			]);
		}
		out[school.id] = strict(record);
	}
	return out;
}

/** `people(s)`: the Reader's people; a role holder the body pushed into `s.R` is a role-only person with no plan. */
const peopleOf = (school: School): Person[] => {
	const people = school.people ?? [];
	const listed = new Set(people.map(({ id }) => id));
	const extra = (school.R ?? [])
		.filter(({ id }) => !listed.has(id))
		.map(
			(holder): Person => ({
				financeGrant: false,
				planHolder: false,
				memberKey: null,
				family: null,
				audience: "public",
				audienceReason: "",
				attention: [],
				you: false,
				...holder,
			}),
		);
	return [...people, ...extra];
};

/** A mockup history row: the UI row with the mockup's field names beside its own. */
type MockupRow = PortalHistoryRow & {
	d: string;
	m: string;
	tx: string;
	amt: number;
	cur: string;
	st: string;
	inv: string;
	pay: string;
};
const mockupRow = (row: PortalHistoryRow): MockupRow => ({
	...row,
	d: row.date,
	m: row.profileId,
	tx: row.description,
	amt: row.amountCents / 100,
	cur: row.currency,
	st: paymentStatusLabels[row.status],
	inv: row.invoiceId,
	pay: row.paymentId,
});
type MemberTuple = [string, string];
/** The school the mockup's history checks read (`T.SC.b4u`). */
const historySchool = "b4u";
const portalsOf = async (
	reader: Reader,
): Promise<Map<string, MemberPortal>> => {
	const portals = new Map<string, MemberPortal>();
	for (const person of await reader.people({ schoolId: historySchool })) {
		const portal = await reader.memberPortal({
			school: historySchool,
			profileId: person.id,
		});
		if (portal) portals.set(person.id, portal);
	}
	return portals;
};
const portalOf = (
	portals: Map<string, MemberPortal>,
	member: MemberTuple | undefined,
): MemberPortal => {
	const portal = member ? portals.get(member[0]) : undefined;
	if (!portal) throw new Error(`no member portal for ${member?.[0]}`);
	return portal;
};

const viewAsOf = (school: School): ViewAs | null => {
	const route = parseRoute(window.location.hash, [school.id]);
	return route.schoolId === school.id
		? (route.query.get("as") as ViewAs | null)
		: null;
};

const shims: Shims = {
	schools: schoolsOf,
	/** `kEmit(s, draft?)`: the Code text of the school's draft, by the UI's `emitMenu`. */
	kEmit: () => (school: School, draft?: Menu) =>
		emitMenu({
			schoolName: school.name,
			version: school.pl.version,
			menu: draft ?? school.pl.draft,
			stripe: school.stripe,
		}),
	/** `kParse(text, s)`: the UI's `parseMenu`, answered as `{ok, draft}` or `{ok: false, line, msg}`. */
	kParse: () => (text: string, school: School) => {
		const parsed = parseMenu(text, {
			version: school.pl.version,
			previous: school.pl.draft,
		});
		return parsed.ok
			? { ok: true, draft: parsed.menu }
			: { ok: false, line: parsed.line, msg: parsed.message };
	},
	people: () => peopleOf,
	/** `roleGuard(s, person, kind)`: the UI's own guard (the one the ⋯ menu uses) with the viewer's capabilities. */
	roleGuard: () => (school: School, person: Person, kind: RoleChange) =>
		roleGuard(
			school.capabilities ?? ({} as Capabilities),
			peopleOf(school),
			person,
			kind,
		),
	/** `kHist(s, m)`: the person's own rows, as the Reader's portal document holds them. */
	kHist: async (reader) => {
		const portals = await portalsOf(reader);
		return (_school: unknown, member: MemberTuple | undefined) =>
			portalOf(portals, member)
				.history.filter((row) => row.profileId === member?.[0])
				.map(mockupRow);
	},
	/** `kScope(s, m)`: every row the person's portal shows (an adult: the family). */
	kScope: async (reader) => {
		const portals = await portalsOf(reader);
		return (_school: unknown, member: MemberTuple | undefined) =>
			portalOf(portals, member).history.map(mockupRow);
	},
	/** `kFilter(rows, period)`: the UI's `historyRowsIn` at the app's clock. */
	kFilter: () => (rows: MockupRow[], period: HistoryPeriod) =>
		historyRowsIn(rows, period, clock),
	/** `kCsv(rows, {member})`: the UI's CSV helper over the history columns, the mockup row renamed. */
	/** `bkSize(s, y)`: the school's size from the Reader's disclosure (`size`, fixed for `year` on its first day from
	 * the last closed year's income). The disclosure contract, and the oracle that builds the documents from it, carry
	 * the size of that one year only; for any other year there is no counterpart, so the call throws rather than guess. */
	bkSize: () => (school: School, year: number) => {
		if (year === school.disclosure.year) return school.disclosure.size;
		throw new Error(
			`bkSize(${school.id}, ${year}): the disclosure carries the school size for ${school.disclosure.year} only`,
		);
	},
	kCsv:
		() =>
		(
			rows: Array<{
				d: string;
				m: string;
				tx: string;
				amt: number;
				cur: string;
				st: string;
				inv?: string;
				pay?: string;
			}>,
			options?: { member?: boolean },
		) =>
			toCsv(
				historyColumns(Boolean(options?.member)),
				rows.map(
					(row): HistoryCsvRow => ({
						date: row.d,
						member: row.m,
						description: row.tx,
						amountCents: Math.round(row.amt * 100),
						currency: row.cur,
						status: row.st,
						invoiceId: row.inv ?? "",
						paymentId: row.pay ?? "",
					}),
				),
			),
	/** `vaAllowed(s, sub)`: the Reader's `viewAs[].held`, which the View as list renders as enabled rows. */
	vaAllowed: () => (school: School, sub: ViewAs) =>
		school.disclosure.viewAs.find(({ value }) => value === sub)?.held === true,
	/** `VW(s)`: what the route views, by the UI's `resolveViewAs` over the route's `as=`, as the shell does. */
	VW: () => (school: School) => {
		const { disclosure } = school;
		const { option, preview } = resolveViewAs(viewAsOf(school), disclosure);
		return {
			sub: option.value,
			you: disclosure.viewer.viewAs,
			pv: preview,
			aud: option.audience,
			admin: option.admin,
			fin: option.value === "owner" || option.value === "finance",
			own: option.value === "owner",
		};
	},
};

export async function uiInternals(
	reader: Reader,
	internals: Record<string, string | null>,
): Promise<Record<string, unknown>> {
	/** PARITY_SHIMS_EXTRA (comma-separated module paths, each exporting `shims`) adds shims, for trying them out. */
	for (const path of (process.env.PARITY_SHIMS_EXTRA ?? "")
		.split(",")
		.filter(Boolean))
		Object.assign(shims, ((await import(path)) as { shims: Shims }).shims);
	const out: Record<string, unknown> = {};
	for (const [key, shim] of Object.entries(internals)) {
		if (!key.startsWith("window.__t.") || shim === null) continue;
		const provide = shims[shim];
		if (!provide) throw new Error(`map.json names an unknown shim: ${shim}`);
		out[key.slice("window.__t.".length)] = await provide(reader);
	}
	return out;
}
