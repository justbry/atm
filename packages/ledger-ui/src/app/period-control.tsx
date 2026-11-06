import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icon.tsx";
import {
	type Period,
	periodLabel,
	periodPresets,
	samePeriod,
	shiftPeriod,
} from "./period.ts";
import { Popover } from "./popover.tsx";

type PeriodControlProps = {
	period: Period;
	today: string;
	/** The mockup shows the control only where a period applies: Ledger, Reports and All schools. */
	shown: boolean;
	timeZoneNote: string;
	onChoose: (period: Period) => void;
};

/** The top bar's period control (mockup `#per`, `renderPP`): previous, the period dialog, next. Next stops at the
 * clock's month. */
export function PeriodControl({
	period,
	today,
	shown,
	timeZoneNote,
	onChoose,
}: PeriodControlProps): JSX.Element {
	/** Only the checkbox reads it until Reports compares periods; kept here so it outlives the dialog. */
	const [compare, setCompare] = useState(false);
	const next = shiftPeriod(period, 1);
	return (
		<div class="pgrp" hidden={!shown}>
			<button
				type="button"
				class="btn ico"
				data-test="period-prev"
				aria-label="Previous period"
				onClick={() => onChoose(shiftPeriod(period, -1))}
			>
				<Icon name="chevronLeft" />
			</button>
			<Popover
				trigger={{
					class: "btn",
					"data-test": "period-button",
					"aria-haspopup": "dialog",
				}}
				panel={{ role: "dialog", "aria-label": "Period" }}
				alignRight
				label={
					<>
						<Icon name="calendar" />
						<span class="button-label">{periodLabel(period)}</span>
						<Icon name="chevronDown" />
					</>
				}
			>
				{(close) => (
					<PeriodChoices
						period={period}
						today={today}
						timeZoneNote={timeZoneNote}
						compare={compare}
						onCompareChange={setCompare}
						onChoose={(chosen) => {
							close();
							onChoose(chosen);
						}}
					/>
				)}
			</Popover>
			<button
				type="button"
				class="btn ico"
				data-test="period-next"
				aria-label="Next period"
				disabled={next.from > today}
				onClick={() => onChoose(next)}
			>
				<Icon name="chevronRight" />
			</button>
		</div>
	);
}

type PeriodChoicesProps = {
	period: Period;
	today: string;
	timeZoneNote: string;
	compare: boolean;
	onCompareChange: (compare: boolean) => void;
	onChoose: (period: Period) => void;
};

/** The dialog's content. Opening it focuses the chosen preset, or the custom range's start when no preset is
 * chosen. A custom range may not start after the clock's today. */
function PeriodChoices({
	period,
	today,
	timeZoneNote,
	compare,
	onCompareChange,
	onChoose,
}: PeriodChoicesProps): JSX.Element {
	const [from, setFrom] = useState(period.from);
	const [to, setTo] = useState(period.to);
	const chosenPreset = useRef<HTMLButtonElement>(null);
	const fromInput = useRef<HTMLInputElement>(null);
	useEffect(() => (chosenPreset.current ?? fromInput.current)?.focus(), []);
	let problem = "";
	if (!from || !to) problem = "Pick both dates.";
	else if (from > today) problem = "Start is after today.";
	else if (from > to) problem = "Start is after the end.";
	return (
		<>
			{periodPresets(today).map((preset) => {
				const chosen = samePeriod(preset.period, period);
				return (
					<button
						key={preset.label}
						ref={chosen ? chosenPreset : null}
						type="button"
						class={chosen ? "it on" : "it"}
						data-test="period-option"
						aria-current={chosen ? "true" : undefined}
						onClick={() => onChoose(preset.period)}
					>
						<span class="sp2">{preset.label}</span>
						<span class="mut">{periodLabel(preset.period)}</span>
					</button>
				);
			})}
			<hr />
			<div class="cus" data-test="period-option">
				<span class="range-title">Custom range</span>
				<div class="two">
					<input
						ref={fromInput}
						type="date"
						aria-label="From"
						max={today}
						value={from}
						onInput={(event) => setFrom(event.currentTarget.value)}
					/>
					<input
						type="date"
						aria-label="To"
						max={today}
						value={to}
						onInput={(event) => setTo(event.currentTarget.value)}
					/>
				</div>
				<div class="cnote" aria-live="polite">
					{problem}
				</div>
				<button
					type="button"
					class="btn p s"
					disabled={problem !== ""}
					onClick={() => onChoose({ from, to })}
				>
					Apply
				</button>
			</div>
			<hr />
			<label class="chk">
				<input
					type="checkbox"
					checked={compare}
					onChange={(event) => onCompareChange(event.currentTarget.checked)}
				/>{" "}
				Compare with previous period
			</label>
			<div class="mut tzn">{timeZoneNote}</div>
		</>
	);
}
