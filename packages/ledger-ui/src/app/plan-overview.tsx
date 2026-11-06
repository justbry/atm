import type { JSX } from "preact";
import type { PlanSummary } from "../data/plans.ts";
import { Icon, type IconName } from "./icon.tsx";
import { formatMoney } from "./money.ts";
import { monthName } from "./period.ts";
import { financeOnlyText, Withheld } from "./plan-tables.tsx";
import type { PlansView } from "./plans-menu.ts";
import { exitPreviewTitle } from "./viewing.ts";

export type SetupStepKey = "stripe" | "plan" | "publish" | "link";
type SetupStep = {
	key: SetupStepKey;
	title: string;
	detail: string;
	done: boolean;
};

/** Mockup `setupSteps`: what a school does before it sells. */
export const setupSteps = (facts: {
	stripeConnected: boolean;
	hasDraftMembership: boolean;
	hasPublishedPlans: boolean;
	purchaseLinkShared: boolean;
}): SetupStep[] => [
	{
		key: "stripe",
		title: "Connect Stripe",
		detail: "Take payments through your own account",
		done: facts.stripeConnected,
	},
	{
		key: "plan",
		title: "Add a membership",
		detail: "Name it, price it, say what members get",
		done: facts.hasDraftMembership,
	},
	{
		key: "publish",
		title: "Publish your plans",
		detail: "Makes them available to buy",
		done: facts.hasPublishedPlans,
	},
	{
		key: "link",
		title: "Share your purchase link",
		detail: "Copy it into your website or email",
		done: facts.purchaseLinkShared,
	},
];

/** Get started (mockup `setupHtml`): the steps, how many are done, and the next one. Writes are off in a preview. */
export function PlanSetup({
	steps,
	preview,
	onStep,
}: {
	steps: SetupStep[];
	preview: boolean;
	onStep: (key: SetupStepKey) => void;
}): JSX.Element | null {
	const done = steps.filter((step) => step.done).length;
	const next = steps.find((step) => !step.done);
	if (!next) return null;
	const title = preview ? exitPreviewTitle : undefined;
	return (
		<div class="card setup-card" data-test="plan-setup">
			<div class="sphead">
				<b>
					<Icon name="check" /> Get started
				</b>
				<span class="mut" data-test="plan-setup-count">
					{done} of {steps.length} done
				</span>
			</div>
			<div class="prog">
				<i style={{ width: `${(done / steps.length) * 100}%` }} />
			</div>
			<div class="steps2">
				{steps.map((step) => (
					<button
						key={step.key}
						type="button"
						class={`st${step.done ? " done" : step === next ? " next" : ""}`}
						data-test="plan-setup-step"
						data-step={step.key}
						title={step.done ? undefined : title}
						disabled={step.done || preview}
						onClick={() => onStep(step.key)}
					>
						<Icon
							name={
								step.done ? "check" : step === next ? "chevronRight" : "dot"
							}
						/>
						<span>
							<b>{step.title}</b>
							<small>{step.detail}</small>
						</span>
					</button>
				))}
			</div>
			<div class="row2 setup-next">
				<button
					type="button"
					class="btn p"
					data-test="plan-setup-next"
					title={title}
					disabled={preview}
					onClick={() => onStep(next.key)}
				>
					Next: {next.title}
					<Icon name="chevronRight" />
				</button>
			</div>
		</div>
	);
}

function PlanStat({
	stat,
	icon,
	label,
	onClick,
	children,
}: {
	stat: string;
	icon: IconName;
	label: string;
	onClick: () => void;
	children: JSX.Element | string | number;
}): JSX.Element {
	return (
		<button
			type="button"
			class="stat"
			data-test="plan-stat"
			data-stat={stat}
			onClick={onClick}
		>
			<small data-test="plan-stat-label">
				<Icon name={icon} /> {label}
			</small>
			<b
				class={stat === "attention" ? "neg" : undefined}
				data-test="plan-stat-value"
			>
				{children}
			</b>
		</button>
	);
}

/** The month's gross, withheld from an admin without the finance grant; "—" before anything is sold. */
function collectedFigure(
	view: PlansView,
	collected: PlanSummary["collected"],
	currency: string,
): JSX.Element | string {
	if (!view.finance) return <Withheld text={financeOnlyText} />;
	return collected ? formatMoney(collected.amount, currency) : "—";
}

/** The strip over the tables (mockup `strip`): the server's counts and the month's gross, which an admin without the
 * finance grant does not see. Active members, Ending soon and Need attention open Members; Collected the Dashboard. Collected names the month the
 * viewed period reads from (mockup `dm`) while its figure is withheld; with a figure it names the month the server
 * summed, so the label never claims a month the figure is not for. */
export function PlanStrip({
	view,
	summary,
	currency,
	attentionCount,
	viewedMonth,
	onMembers,
	onDashboard,
}: {
	view: PlansView;
	summary: PlanSummary;
	currency: string;
	attentionCount: number;
	/** The month the viewed period reads from (`YYYY-MM-01`): it names the stat when its figure is withheld. */
	viewedMonth: string;
	onMembers: () => void;
	onDashboard: () => void;
}): JSX.Element {
	const { collected } = summary;
	return (
		<div class="strip s4 plan-strip">
			<PlanStat
				stat="active"
				icon="users"
				label="Active members"
				onClick={onMembers}
			>
				{summary.activeMembers}
			</PlanStat>
			<PlanStat
				stat="collected"
				icon="coin"
				label={
					collected
						? `Collected in ${monthName(view.finance ? `${collected.period}-01` : viewedMonth)}`
						: "Collected"
				}
				onClick={onDashboard}
			>
				{collectedFigure(view, collected, currency)}
			</PlanStat>
			<PlanStat
				stat="ending"
				icon="clock"
				label="Ending soon"
				onClick={onMembers}
			>
				{summary.endingSoon}
			</PlanStat>
			<PlanStat
				stat="attention"
				icon="alert"
				label="Need attention"
				onClick={onMembers}
			>
				{attentionCount}
			</PlanStat>
		</div>
	);
}
