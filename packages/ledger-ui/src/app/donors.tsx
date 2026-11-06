import { Fragment, type JSX } from "preact";
import {
	audienceNames,
	csvFileNames,
	type DonorRow,
	type DonorsReport,
	donorsColumns,
	type ReportCell,
	type ViewerAudience,
} from "../data/ledger.ts";
import {
	type BooksPaneProps,
	identitiesLockHeading,
	smallCount,
} from "./books-pane.ts";
import { DownloadButton } from "./download-button.tsx";
import { Icon } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { formatMoney } from "./money.ts";
import { monthAndDay } from "./period.ts";
import { Figure, type Labels } from "./report-figure.tsx";

const topDonors = 15;

const spreadColors = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];
const shortBucketLabels: Record<string, string> = {
	"under $100": "< $100",
	"$1,000 or more": "$1,000+",
};

function DonorTable({
	report,
	audience,
	currency,
}: {
	report: Extract<DonorsReport, { kind: "identified" }>;
	audience: ViewerAudience;
	currency: string;
}): JSX.Element {
	const shown = report.rows.slice(0, topDonors);
	return (
		<>
			<table>
				<thead>
					<tr>
						<th>Name</th>
						<th>Kind</th>
						<th>Id</th>
						<th class="r">Payments</th>
						<th class="r">Total</th>
						<th>Last</th>
					</tr>
				</thead>
				<tbody>
					{shown.map((row: DonorRow) => (
						<tr key={row.id} data-test="donor-row" data-id={row.id}>
							<td data-test="donor-name">
								<b>{row.name}</b>
								{row.anonymous &&
									(audience === "owner" ? (
										<>
											{" "}
											<span
												class="badge"
												title="Anonymous to the finance admin: only the owner sees this name"
											>
												Anonymous to finance
											</span>
										</>
									) : (
										<>
											{" "}
											<span class="mut">name with the owner only</span>
										</>
									))}
							</td>
							<td data-test="donor-kind">
								{row.kind === "donor" ? "Donor" : "Member"}
								{row.fund && (
									<>
										{" "}
										<span class="mut">{`· ${row.fund}`}</span>
									</>
								)}
							</td>
							<td class="mono mut" data-test="donor-id">
								{row.id}
							</td>
							<td class="r" data-test="donor-payments">
								{row.payments}
							</td>
							<td class="r" data-test="donor-total">
								{formatMoney(row.totalCents, currency)}
							</td>
							<td class="mut" data-test="donor-last">
								{monthAndDay(row.lastPaymentOn)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{report.rows.length > shown.length && (
				<p class="mut" style="margin:6px 0 0" data-test="donors-more">
					{`Top ${shown.length} of ${report.rows.length} by amount. Download for the full list.`}
				</p>
			)}
		</>
	);
}

function DonorSpread({
	report,
	currency,
	labels,
}: {
	report: Extract<DonorsReport, { kind: "spread" }>;
	currency: string;
	labels: Labels;
}): JSX.Element {
	const { donors, buckets, medianCents } = report;
	const year = report.through.slice(0, 4);
	const plain = (
		cell: ReportCell,
		noun: string,
		money = false,
	): JSX.Element => (
		<Figure
			cell={cell}
			money={money}
			currency={currency}
			whole
			labels={labels}
			noun={noun}
		/>
	);
	const numbers = buckets.flatMap(({ donors: cell }) =>
		typeof cell === "number" ? [cell] : [],
	);
	const highest = Math.max(1, ...numbers);
	const reasons = buckets.filter(({ why }) => why !== null);
	if (typeof donors === "number" && donors === 0)
		return <div class="mut">{`No donations recorded in ${year} yet.`}</div>;
	if (typeof donors !== "number")
		return (
			<>
				<div class="kdistline">{plain(donors, "donors")} donors</div>
				<div class="kwhy">
					<Icon name="lock" />
					<span>
						{`Fewer than ${smallCount} donors so far, so no spread is shown.`}
					</span>
				</div>
			</>
		);
	return (
		<>
			<div class="kdistline">
				<b>{`${donors} donors`}</b>
				{": "}
				{buckets.map(({ label, donors: cell }, index) => (
					<Fragment key={label}>
						{index > 0 && ", "}
						{plain(cell, "donors")} {label}
					</Fragment>
				))}
				{"; median gift "}
				{plain(medianCents, "donors", true)}
			</div>
			{buckets.map(({ label, donors: cell, why }, index) => (
				<div key={label} class="krow">
					<span title={label}>{shortBucketLabels[label] ?? label}</span>
					<div class="t">
						{!why && typeof cell === "number" && (
							<i
								style={{
									width: `${(cell / highest) * 100}%`,
									background: spreadColors[index % spreadColors.length] ?? "",
								}}
							/>
						)}
					</div>
					<b>
						{why ? (
							<span class="kapprox" title={`Rounded to the nearest 10: ${why}`}>
								{plain(cell, "donors")}
							</span>
						) : (
							plain(cell, "donors")
						)}
					</b>
				</div>
			))}
			{reasons.length > 0 && (
				<div class="kwhy">
					<Icon name="lock" />
					<span>
						{reasons.map(({ label, why }) => `${label}: ${why}`).join(" · ")}
					</span>
				</div>
			)}
		</>
	);
}

/** The Donors and payers card: the identified table for finance and the owner (every identified read is audited), how
 * gifts spread for governance, and a lock panel below. */
export function Donors({
	report,
	audience,
	currency,
	labels,
	today,
	writer,
	onToast,
}: {
	report: DonorsReport;
	audience: ViewerAudience;
	currency: string;
	labels: Labels;
	today: string;
	writer: BooksPaneProps["writer"];
	onToast: (text: string) => void;
}): JSX.Element {
	if (report.kind === "none")
		return (
			<>
				<h5 data-test="donors-title">
					<Icon name="users" /> Donors and payers
				</h5>
				<LockPanel
					lock={{
						reason: "no_grant",
						who: identitiesLockHeading,
						when: `Names and per-person amounts. Governance sees how gifts spread. ${audienceNames[audience]} sees totals and categories only.`,
					}}
					hooks="books"
				/>
			</>
		);
	if (report.kind === "spread")
		return (
			<>
				<h5 data-test="donors-title">
					<Icon name="users" /> How donors give{" "}
					<span class="mut" style="text-transform:none;font-weight:400">
						spread, no names
					</span>
				</h5>
				<DonorSpread report={report} currency={currency} labels={labels} />
				<p class="mut" style="margin:8px 0 0">
					<Icon name="info" />
					{` ${report.through.slice(0, 4)} to the end of ${monthAndDay(`${report.through}-01`).slice(0, 3)} (closed months). Names, emails and per-person rows show to finance admins and the owner only.`}
				</p>
			</>
		);
	return (
		<>
			<h5>
				<span data-test="donors-title">
					<Icon name="users" /> Donors and payers{" "}
					<span class="mut" style="text-transform:none;font-weight:400">
						{`${report.year} to date · ${report.donorCount} donor${report.donorCount === 1 ? "" : "s"}, ${report.payerCount} member payer${report.payerCount === 1 ? "" : "s"}`}
					</span>
				</span>
				<span style="float:right;text-transform:none">
					<DownloadButton
						writer={writer}
						onToast={onToast}
						test="donors-csv"
						className="link"
						title="Download donors and payers as CSV"
						label="Download CSV"
						name={csvFileNames.donors(today)}
						columns={donorsColumns(currency)}
						rows={report.rows}
					/>
				</span>
			</h5>
			{report.rows.length > 0 ? (
				<DonorTable report={report} audience={audience} currency={currency} />
			) : (
				<div class="mut" data-test="donors-empty">
					No donors or payers yet.
				</div>
			)}
			<p class="mut" style="margin:8px 0 0" data-test="donors-audit">
				<Icon name="eye" /> Every identified read is audited.
			</p>
		</>
	);
}
