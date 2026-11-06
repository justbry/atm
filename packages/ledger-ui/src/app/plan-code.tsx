import type { JSX } from "preact";
import { useId, useRef } from "preact/hooks";
import type { School } from "../data/types.ts";
import { Icon, type IconName } from "./icon.tsx";
import { diffMenus, type PlansSession, problems } from "./plans-menu.ts";
import { emitMenu, type ParsedMenu, parseMenu } from "./plans-yaml.ts";
import { exitPreviewTitle } from "./viewing.ts";

const lineHeight = 18;
const linesAboveJump = 3;

type PlanCodeProps = {
	school: School;
	session: PlansSession;
	/** Owners edit plans; everyone reads and copies. */
	owner: boolean;
	/** An audience other than your own is shown: Format, Reset and the text are read-only. */
	preview: boolean;
	onType: (text: string) => void;
	onBlur: () => void;
	onFormat: () => void;
	onReset: () => void;
	onToast: (text: string) => void;
};

/** Plans as YAML (mockup `kCodeHtml`, `kBind`): a toolbar, a line-numbered editor, the parse error or the problems with
 * a jump to each line, and the changes against the published plans. The text is the draft's second view: applying it
 * is the pane's job (`onType`, `onBlur`). */
export function PlanCode({
	school,
	session,
	owner,
	preview,
	onType,
	onBlur,
	onFormat,
	onReset,
	onToast,
}: PlanCodeProps): JSX.Element {
	const textarea = useRef<HTMLTextAreaElement>(null);
	const gutter = useRef<HTMLDivElement>(null);
	const helpId = useId();
	/** What was typed, else the draft in the standard layout. */
	const text =
		session.yamlText ??
		emitMenu({
			schoolName: school.name,
			version: session.version,
			menu: session.draft,
			stripe: session.stripe,
		});
	const parsed = parseMenu(text, {
		version: session.version,
		previous: session.draft,
	});
	const found = problems(session.draft);
	const changes = diffMenus(session.live, session.draft);
	const located = found.map((problem) => ({
		problem,
		line: parsed.ok ? lineOf(problem, parsed) : null,
	}));
	const badLines = new Set(
		parsed.ok
			? located.flatMap(({ line }) => (line === null ? [] : [line]))
			: [parsed.line],
	);
	const writable = owner && !preview;
	const pill = statusPill(parsed, found.length);

	const jumpTo = (line: number): void => {
		const area = textarea.current;
		if (!area) return;
		const rows = area.value.split("\n");
		const start = rows
			.slice(0, line - 1)
			.reduce((offset, row) => offset + row.length + 1, 0);
		area.focus();
		area.setSelectionRange(start, start + (rows[line - 1]?.length ?? 0));
		area.scrollTop = Math.max(0, (line - linesAboveJump) * lineHeight);
		if (gutter.current) gutter.current.scrollTop = area.scrollTop;
	};
	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			onToast("YAML copied.");
		} catch {
			textarea.current?.select();
			onToast("Press Ctrl or Cmd+C to copy.");
		}
	};
	const jumpButton = (line: number): JSX.Element => (
		<button
			type="button"
			class="link"
			data-line={line}
			aria-label={`Go to line ${line}`}
			onClick={() => jumpTo(line)}
		>
			line {line}
		</button>
	);

	return (
		<div class="kcode">
			<div class="kmain">
				<div class="ktool" role="toolbar" aria-label="YAML editor">
					<button
						type="button"
						class="btn s"
						data-test="plan-yaml-format"
						title={
							preview
								? exitPreviewTitle
								: "Rewrite the document in the standard layout"
						}
						disabled={!writable}
						onClick={onFormat}
					>
						<Icon name="sliders" />
						Format
					</button>
					<button
						type="button"
						class="btn s"
						data-test="plan-yaml-copy"
						title="Copy the YAML"
						onClick={copy}
					>
						<Icon name="copy" />
						Copy
					</button>
					<button
						type="button"
						class="btn s"
						data-test="plan-yaml-reset"
						title={
							preview
								? exitPreviewTitle
								: "Replace the draft with what is published"
						}
						disabled={!(writable && session.hasChanges)}
						onClick={onReset}
					>
						<Icon name="undo" />
						Reset to published
					</button>
					<span class="sp" />
					<output class={`kpill ${pill.tone}`} data-test="plan-yaml-status">
						<Icon name={pill.icon} />
						{pill.label}
					</output>
				</div>
				<p class="kmut" id={helpId} data-test="plan-yaml-help">
					<Icon name="info" /> Comments are not saved: plans are stored as JSON.
					Anchors, aliases and tags are not accepted.
				</p>
				{!owner && (
					<div class="lock" data-test="plan-yaml-lock">
						<Icon name="lock" /> Owners edit plans. You can read and copy this
						YAML.
					</div>
				)}
				<div class="ked">
					<div ref={gutter} class="kgut" aria-hidden="true">
						{text.split("\n").map((_, index) => (
							<i
								// biome-ignore lint/suspicious/noArrayIndexKey: the gutter numbers the lines of the text; a line has no other identity
								key={index}
								class={badLines.has(index + 1) ? "bad" : undefined}
								data-test="plan-yaml-line"
							>
								{index + 1}
							</i>
						))}
					</div>
					<textarea
						ref={textarea}
						class="kta"
						spellcheck={false}
						wrap="off"
						autocomplete="off"
						autocapitalize="off"
						aria-label="Plans as YAML"
						aria-describedby={helpId}
						data-test="plan-yaml"
						readOnly={!writable}
						value={text}
						onInput={(event) => onType(event.currentTarget.value)}
						onBlur={onBlur}
						onScroll={(event) => {
							if (gutter.current)
								gutter.current.scrollTop = event.currentTarget.scrollTop;
						}}
					/>
				</div>
				<div class="kmsg" aria-live="polite" data-test="plan-yaml-message">
					{!parsed.ok ? (
						<>
							<div class="err" role="alert">
								<Icon name="xCircle" /> Line {parsed.line}: {parsed.message}{" "}
								{jumpButton(parsed.line)}
							</div>
							<div class="mut">The draft is unchanged until this is fixed.</div>
						</>
					) : located.length > 0 ? (
						located.map(({ problem, line }) => (
							<div class="err" key={problem}>
								<Icon name="alert" /> {problem}{" "}
								{line !== null && jumpButton(line)}
							</div>
						))
					) : (
						<div class="ok">
							<Icon name="check" /> No problems.
						</div>
					)}
				</div>
			</div>
			<aside
				class="kchg"
				aria-label="Changes vs published"
				data-test="plan-changes"
			>
				<h5>
					<Icon name="list" /> Changes vs published{" "}
					<span class="mut changes-count" data-test="plan-changes-count">
						{changes.length}
					</span>
				</h5>{" "}
				{changes.length > 0 ? (
					changes.map((change) => (
						<div
							class="kc"
							key={`${change.kind}:${change.id}`}
							data-test="plan-change"
							data-plan={change.id}
						>
							<b>{change.name}</b>{" "}
							{change.status === "removed" && (
								<span class="badge b-bad" data-test="plan-change-badge">
									Removed
								</span>
							)}
							{change.status === "new" && (
								<span class="badge b-ok" data-test="plan-change-badge">
									New
								</span>
							)}
							{change.lines.map((line) => (
								<div key={line.title}>
									<div>{line.title}</div>
									<div class="mut">{line.detail}</div>
								</div>
							))}
						</div>
					))
				) : (
					<div class="mut">No changes yet. This matches what is published.</div>
				)}
			</aside>
		</div>
	);
}

/** The status pill: the parse error, the problems, or Valid. */
function statusPill(
	parsed: ParsedMenu,
	problemCount: number,
): { tone: string; icon: IconName; label: string } {
	if (!parsed.ok)
		return {
			tone: "bad",
			icon: "xCircle",
			label: `Parse error at line ${parsed.line}`,
		};
	if (problemCount > 0)
		return {
			tone: "warn",
			icon: "alert",
			label: `${problemCount} problem${problemCount === 1 ? "" : "s"}`,
		};
	return { tone: "ok", icon: "check", label: "Valid" };
}

/** Mockup `kLocate`: the line a problem belongs to, from the plan it names; a missing name is the first unnamed
 * plan; a limit on memberships or packs is the line of that list. */
function lineOf(
	problem: string,
	parsed: Extract<ParsedMenu, { ok: true }>,
): number | null {
	const named = parsed.items.find(
		({ name }) => name && problem.startsWith(`${name}:`),
	);
	if (named) return named.line;
	if (problem === "A plan needs a name.")
		return parsed.items.find(({ name }) => !name.trim())?.line ?? null;
	if (/memberships/.test(problem)) return parsed.membershipsLine;
	if (/packs/.test(problem)) return parsed.packsLine;
	return null;
}
