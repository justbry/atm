import { Fragment, type JSX } from "preact";
import { audienceNames } from "../data/disclosure.ts";
import type {
	AttentionReason,
	MemberBalance,
	Person,
} from "../data/members.ts";
import { Icon } from "./icon.tsx";
import {
	attentionLabel,
	audienceIcons,
	barOf,
	type Projection,
	roleLabels,
} from "./members-model.ts";

/** The small pieces a row and the drawer both draw (mockup `rolePill`, `finPill`, `audPill`, `badges`, `bar3`). */

export function RoleChip({ role }: { role: Person["role"] }): JSX.Element {
	return (
		<span class={`krole kr-${role}`} data-test="role-chip" data-role={role}>
			<Icon name={role === "member" ? "user" : "key"} />
			{roleLabels[role]}
		</span>
	);
}

/** Owners have money implicitly and show no chip. */
export function FinanceChip({
	person,
}: {
	person: Person;
}): JSX.Element | null {
	if (person.role !== "admin" || !person.financeGrant) return null;
	return (
		<span
			class="kfin"
			data-test="finance-chip"
			title="Finance grant: can see money"
		>
			Finance
		</span>
	);
}

export function AudienceChip({ person }: { person: Person }): JSX.Element {
	const { audience } = person;
	return (
		<span
			class={`kbk kbk-${audience}`}
			data-test="audience-chip"
			data-audience={audience}
			title={`Audience: ${person.audienceReason}`}
		>
			<Icon name={audienceIcons[audience]} />
			Audience:{" "}
			{audience === "owner" ? "Owner · everything" : audienceNames[audience]}
		</span>
	);
}

export function AttentionBadges({
	reasons,
	unitPlural,
}: {
	reasons: AttentionReason[];
	unitPlural: string;
}): JSX.Element {
	return (
		<>
			{reasons.map((reason, index) => (
				<Fragment key={`${reason.kind}-${reason.bookingId}`}>
					{index > 0 && " "}
					<span
						class={`badge b-${reason.tone}`}
						data-test="attention-badge"
						data-kind={reason.kind}
					>
						{attentionLabel(reason, unitPlural)}
					</span>
				</Fragment>
			))}
		</>
	);
}

const segments = ["used", "held", "available"] as const;
const segmentClasses = { used: "u", held: "h", available: "a" } as const;

/** Used, held for bookings and available, out of what was granted. */
export function BalanceBar({
	balance,
	projection,
}: {
	balance: MemberBalance;
	projection: Projection;
}): JSX.Element {
	const { low, percents } = barOf(balance, projection);
	return (
		<div
			class={low ? "bar3 low" : "bar3"}
			data-test="balance-bar"
			title={`used ${projection.used} · held ${projection.held} · available ${projection.available}`}
		>
			{segments.map((segment) => (
				<i
					key={segment}
					class={segmentClasses[segment]}
					data-test="bar-segment"
					data-segment={segment}
					data-count={projection[segment]}
					style={{ width: percents[segment] }}
				/>
			))}
		</div>
	);
}
