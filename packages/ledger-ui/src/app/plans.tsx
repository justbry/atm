import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Menu, planLimits } from "../data/plans.ts";
import type { Reader } from "../data/reader.ts";
import type { School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { Icon } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { PlanCode } from "./plan-code.tsx";
import { PlanDrawer } from "./plan-drawer.tsx";
import {
	PlanSetup,
	PlanStrip,
	type SetupStepKey,
	setupSteps,
} from "./plan-overview.tsx";
import { PlanPreview, type PreviewSource } from "./plan-preview.tsx";
import { PlanPublishDialog } from "./plan-publish-dialog.tsx";
import { PlanTables } from "./plan-tables.tsx";
import {
	changeCount,
	diffMenus,
	emptyMenu,
	type PlanKind,
	type PlansSession,
	plansViewOf,
	problems,
	slug,
	tierCount,
	withDraft,
} from "./plans-menu.ts";
import { type Route, type SchoolTab, withQuery } from "./route.ts";
import { usePlanYaml } from "./use-plan-yaml.ts";
import { exitPreviewTitle, useViewing } from "./viewing.ts";

type Mode = "edit" | "preview" | "code";

const savedToast = "Saved to the draft. Nothing is live until you publish.";
const saveFailedToast = "Could not save the draft. Try again.";
const publishFailedToast = "Could not publish. Try again.";
/** The route parameters only the Plans tab reads: left behind when a link goes to another tab. */
const planParameters = ["mode", "show", "billing"];
const noStripe: PlansSession["stripe"] = {
	products: [],
	prices: [],
	portal: false,
};
const modes: Array<{
	mode: Mode;
	label: string;
	icon: "edit" | "eye" | "code";
}> = [
	{ mode: "edit", label: "Edit", icon: "edit" },
	{ mode: "preview", label: "Preview", icon: "eye" },
	{ mode: "code", label: "Code", icon: "code" },
];

/** Reads what the Plans tab starts from: the newest published version is live, an unpublished newer one is the saved
 * draft (otherwise the draft starts as a copy of the live menu), and a school with no version starts empty. */
async function loadSession(
	reader: Reader,
	school: School,
): Promise<PlansSession> {
	const [{ versions }, summary] = await Promise.all([
		reader.menuVersions(school.id),
		reader.planSummary(school.id),
	]);
	const published = versions.find(({ publishedAt }) => publishedAt !== null);
	const newest = versions[0];
	const saved = newest && newest.publishedAt === null ? newest : undefined;
	const [liveBody, draftBody] = await Promise.all([
		published ? reader.menuVersion(school.id, published.version) : undefined,
		saved ? reader.menuVersion(school.id, saved.version) : undefined,
	]);
	const live =
		liveBody?.menu ??
		emptyMenu(school.currency, school.timeZone, summary.features);
	const draft = draftBody?.menu ?? live;
	return {
		version: liveBody?.version ?? 0,
		live,
		stripe: liveBody?.stripe ?? noStripe,
		draft,
		summary,
		yamlText: null,
		hasChanges: diffMenus(live, draft).length > 0,
	};
}

const modeOf = (query: URLSearchParams): Mode => {
	const asked = query.get("mode");
	return asked === "preview" || asked === "code" ? asked : "edit";
};

/** Mockup `#prev`'s title: why Review and publish is off, or nothing when it is on. */
function reviewTitle(facts: {
	preview: boolean;
	problemCount: number;
	stripeConnected: boolean;
	changeCount: number;
}): string | undefined {
	if (facts.preview) return exitPreviewTitle;
	if (facts.problemCount > 0) return "Fix the problems first";
	if (!facts.stripeConnected) return "Connect Stripe first";
	return facts.changeCount > 0 ? undefined : "Nothing to publish";
}

type PlansProps = {
	reader: Reader;
	writer: Writer;
	school: School;
	route: Route;
	navigate: (route: Route) => void;
	/** The school's session, kept by the Shell for the life of the mount; undefined until it is read. */
	session: PlansSession | undefined;
	onSession: (schoolId: string, session: PlansSession) => void;
	/** Called after each render that shows the school's plans. */
	onRendered: () => void;
	onToast: (text: string) => void;
	/** Get started's Connect Stripe: the settings drawer. */
	onOpenSettings: () => void;
};

/**
 * The Plans pane (mockup `plans()`): one draft shown three ways, Edit (the tables and the plan drawer), Preview (the
 * purchase page) and Code (YAML), chosen by `?mode=` and `?show=`, `?billing=`. The draft and the live menu are the
 * session; a change to the draft is saved whole with `saveMenu` unless it has problems, and Review and publish calls
 * `publishMenu` and then shows the draft as the new live version. The audience is `?as=`: the owner and finance admins
 * see everything, an admin the structure, governance banded counts of the live plans, below it prices only; any other
 * audience than your own turns every write off.
 */
export function Plans({
	reader,
	writer,
	school,
	route,
	navigate,
	session,
	onSession,
	onRendered,
	onToast,
	onOpenSettings,
}: PlansProps): JSX.Element | null {
	const viewing = useViewing();
	const [editing, setEditing] = useState<{
		kind: PlanKind;
		id: string | null;
	} | null>(null);
	const [reviewing, setReviewing] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const loaded = session !== undefined;
	useEffect(() => {
		if (loaded) return;
		let current = true;
		loadSession(reader, school).then((read) => {
			if (current) onSession(school.id, read);
		});
		return () => {
			current = false;
		};
	}, [reader, school, loaded, onSession]);
	useLayoutEffect(() => {
		if (loaded) onRendered();
	});

	/** The newest session, which a handler may read before the render that follows its own commit. */
	const latest = useRef(session);
	latest.current = session;
	const commit = (next: PlansSession): void => {
		latest.current = next;
		onSession(school.id, next);
	};
	const save = (menu: Menu): void => {
		writer.saveMenu(school.id, menu).catch(() => onToast(saveFailedToast));
	};
	/** Makes `menu` the draft; a draft with problems stays on screen, unsaved. */
	const changeDraft = (menu: Menu): void => {
		if (!latest.current) return;
		commit(withDraft(latest.current, menu));
		if (problems(menu).length === 0) save(menu);
	};
	const yaml = usePlanYaml({ latest, commit, save, onToast });

	if (!session) return null;
	const { live, draft, summary } = session;
	const view = plansViewOf(viewing);
	/** The per-plan members and revenue this row may not see (the disclosure's `plans-revenue` surface). */
	const revenueLock = viewing.option.locks["plans-revenue"];
	const owner = school.role === "owner";
	const mode = modeOf(route.query);
	const changes = diffMenus(live, draft);
	const problemList = problems(draft);
	const askedShow = route.query.get("show");
	const defaultShow: PreviewSource = changes.length > 0 ? "draft" : "live";
	const show =
		askedShow === "live" || askedShow === "draft" ? askedShow : defaultShow;
	const canPublish =
		changes.length > 0 &&
		problemList.length === 0 &&
		summary.stripeConnected &&
		!view.preview;
	const writeTitle = view.preview ? exitPreviewTitle : undefined;

	const chooseMode = (chosen: Mode): void =>
		navigate(withQuery(route, "mode", chosen === "edit" ? null : chosen));
	/** To another tab, leaving the plans' own parameters behind and putting `first` ahead of the rest. */
	const leave = (tab: SchoolTab, first?: [string, string]): void => {
		const query = new URLSearchParams(first ? [first] : []);
		for (const [name, value] of route.query)
			if (!planParameters.includes(name)) query.append(name, value);
		navigate({ schoolId: school.id, tab, query });
	};
	const open = (kind: PlanKind, id: string | null): void =>
		setEditing({ kind, id });

	const publish = async (): Promise<void> => {
		setPublishing(true);
		try {
			await writer.publishMenu(school.id);
		} catch {
			setPublishing(false);
			onToast(publishFailedToast);
			return;
		}
		const current = latest.current;
		if (current) {
			const version = current.version + 1;
			commit({
				...current,
				version,
				live: current.draft,
				yamlText: null,
				hasChanges: false,
			});
			onToast(`Published v${version}. The Stripe prices are being updated.`);
		}
		setPublishing(false);
		setReviewing(false);
	};
	const copyPurchaseLink = async (): Promise<void> => {
		const link = `https://b4uni.com/join/${slug(school.name)}`;
		try {
			await navigator.clipboard.writeText(link);
		} catch {
			onToast("Could not copy the link: the browser blocked the clipboard.");
			return;
		}
		const current = latest.current;
		if (current)
			commit({
				...current,
				summary: { ...current.summary, purchaseLinkShared: true },
			});
		onToast(`Purchase link copied: ${link}`);
	};
	/** Mockup `doSetup`. */
	const runStep = (key: SetupStepKey): void => {
		if (key === "stripe") onOpenSettings();
		else if (key === "plan") open("tiers", null);
		else if (key === "link") copyPurchaseLink();
		else if (!summary.stripeConnected) {
			onToast("Connect Stripe first.");
			onOpenSettings();
		} else if (changes.length === 0) {
			onToast("Add a membership first.");
			open("tiers", null);
		} else if (problemList.length > 0)
			onToast("Fix the problems in the plan first.");
		else setReviewing(true);
	};

	const shownTiers = view.admin
		? draft.tiers
		: live.tiers.filter(
				({ public: onSale }) => onSale || view.audience === "governance",
			);
	const editedItem =
		editing === null || editing.id === null
			? null
			: ((editing.kind === "tiers" ? draft.tiers : draft.addons).find(
					({ id }) => id === editing.id,
				) ?? null);
	const affectedMembers = changes.reduce(
		(sum, { kind, id, status }) =>
			kind === "tiers" && status !== "new"
				? sum + tierCount(summary, id).active
				: sum,
		0,
	);

	return (
		<div onClickCapture={yaml.flush}>
			<div inert={editing !== null || reviewing}>
				{view.admin && (
					<PlanSetup
						steps={setupSteps({
							stripeConnected: summary.stripeConnected,
							hasDraftMembership: draft.tiers.length > 0,
							hasPublishedPlans: live.tiers.length + live.addons.length > 0,
							purchaseLinkShared: summary.purchaseLinkShared,
						})}
						preview={view.preview}
						onStep={runStep}
					/>
				)}
				{mode === "edit" && view.admin && live.tiers.length > 0 && (
					<PlanStrip
						view={view}
						summary={summary}
						currency={live.currency}
						attentionCount={school.attentionCount}
						onMembers={() => leave("members")}
						onDashboard={() => leave("dashboard")}
					/>
				)}
				{!view.finance && (
					<p class="mut kplnote" data-test="plan-books-note">
						<Icon name="info" /> Per-plan members and revenue are a breakdown:
						finance admins, the owner and governance see them.
						{view.audience === "admin" &&
							" Admins without the finance grant see the plan structure; this default is the owner's to change."}
					</p>
				)}
				<div class="tools">
					<b>Plans</b>
					<span class="badge" data-test="plan-version">
						{session.version > 0
							? `v${session.version} published`
							: "Not published yet"}
					</span>
					{changes.length > 0 && (
						<span class="badge b-warn" data-test="plan-draft-badge">
							<Icon name="edit" />
							Draft · {changeCount(changes.length)}
						</span>
					)}
					<span class="sp" />
					{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
					<div class="seg" role="group" aria-label="Plans view">
						{modes.map((option) => (
							<button
								key={option.mode}
								type="button"
								class={option.mode === mode ? "on" : undefined}
								aria-pressed={option.mode === mode}
								data-test="plan-mode"
								data-mode={option.mode}
								onClick={() => chooseMode(option.mode)}
							>
								<Icon name={option.icon} />
								{option.label}
							</button>
						))}
					</div>
					{changes.length > 0 && (
						<button
							type="button"
							class="btn"
							data-test="plan-discard"
							title={writeTitle}
							disabled={view.preview}
							onClick={() => {
								changeDraft(live);
								onToast("Draft discarded.");
							}}
						>
							<Icon name="undo" />
							Discard draft
						</button>
					)}
					<button
						type="button"
						class="btn p"
						data-test="plan-review"
						title={reviewTitle({
							preview: view.preview,
							problemCount: problemList.length,
							stripeConnected: summary.stripeConnected,
							changeCount: changes.length,
						})}
						disabled={!canPublish}
						onClick={() => setReviewing(true)}
					>
						<Icon name="upload" />
						Review and publish
					</button>
				</div>
				{problemList.length > 0 && mode !== "code" && (
					<div class="note">
						<Icon name="alert" />
						<span data-test="plan-problems">
							{problemList.length} problem{problemList.length === 1 ? "" : "s"}:{" "}
							{problemList[0]}
							{problemList.length > 1 && ` (+${problemList.length - 1} more)`}
						</span>
					</div>
				)}
				{mode === "edit" && (
					<PlanTables
						view={view}
						menu={view.admin ? draft : live}
						tiers={shownTiers}
						summary={summary}
						changedIds={new Set(changes.map(({ id }) => id))}
						removedNames={changes
							.filter(({ status }) => status === "removed")
							.map(({ name }) => name)}
						full={{
							tiers: draft.tiers.length >= planLimits.tiers,
							addons: draft.addons.length >= planLimits.addons,
						}}
						owner={owner}
						onOpen={open}
						onMembers={(tierId) => leave("members", ["plan", tierId])}
					/>
				)}
				{mode === "edit" && revenueLock && (
					<LockPanel lock={revenueLock} surface="plans-revenue" />
				)}
				{mode === "preview" && (
					<PlanPreview
						schoolName={school.name}
						version={session.version}
						live={live}
						draft={draft}
						changes={changes}
						show={show}
						yearly={route.query.get("billing") === "year"}
						onShow={(chosen) => navigate(withQuery(route, "show", chosen))}
						onBilling={(yearly) =>
							navigate(withQuery(route, "billing", yearly ? "year" : null))
						}
						onEdit={open}
						onToast={onToast}
					/>
				)}
				{mode === "code" && (
					<PlanCode
						school={school}
						session={session}
						owner={owner}
						preview={view.preview}
						onType={yaml.type}
						onBlur={yaml.flush}
						onFormat={yaml.format}
						onReset={() => {
							yaml.cancel();
							changeDraft(live);
							onToast("Draft reset to the published plans.");
						}}
						onToast={onToast}
					/>
				)}
			</div>
			{editing && (editing.id === null || editedItem) && (
				<PlanDrawer
					key={`${editing.kind}:${editing.id ?? "new"}`}
					school={school}
					menu={draft}
					kind={editing.kind}
					item={editedItem}
					activeMembers={
						editing.kind === "tiers" && editedItem
							? tierCount(summary, editedItem.id).active
							: null
					}
					preview={view.preview}
					onSave={(menu) => {
						changeDraft(menu);
						setEditing(null);
						onToast(savedToast);
					}}
					onClose={() => setEditing(null)}
				/>
			)}
			{reviewing && (
				<PlanPublishDialog
					schoolName={school.name}
					fromVersion={session.version}
					changes={changes}
					affectedMembers={affectedMembers}
					owner={owner}
					pending={publishing}
					onPublish={publish}
					onCancel={() => setReviewing(false)}
				/>
			)}
		</div>
	);
}
