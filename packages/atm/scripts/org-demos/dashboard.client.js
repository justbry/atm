// Draws an org's KPI documents (the JSON in #tfd-data) in the school mockup's layout. It derives no figure: a tile is a
// cell of the document, its change line the document's `changes`, and a cell that is not a number is shown by its own
// text. Tabs come from each KPI's disclosure class, so a KPI the document gains shows up in its class's tab.
// Query: ?preset=, ?year=, ?viewer=owner|governance, ?tab=, ?theme=light|dark, ?embed=1 (no "All demos" link).
const DATA = JSON.parse(document.getElementById("tfd-data").textContent);
const query = new URLSearchParams(location.search);
const root = document.documentElement;
const VIEWERS = { owner: "Owner", governance: "Governance" };
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const TABS = [
	{ id: "money", classes: ["income", "cash"], title: "Money" },
	{
		id: "people",
		classes: ["people"],
		title: capitalized(DATA.words.holder.other),
	},
	{ id: "risk", classes: ["losses"], title: "Risk" },
	{
		id: "activity",
		classes: ["activity"],
		title: `Payments and ${DATA.words.credit.other}`,
	},
];
/** Dimension groups: a measure split by a dimension is one stacked chart. */
const GROUPS = {
	revenue_by_tier: `Gross collected by ${DATA.words.plan.one}`,
	revenue_by_kind: "Gross collected by kind",
	donations_by_fund: "Donations by fund",
	donors_by_size: "Donors by size",
};
const COLORS = [
	"var(--c1)",
	"var(--c2)",
	"var(--c3)",
	"var(--c4)",
	"var(--c5)",
	"var(--c6)",
];
const HATCHED = new Set([
	"suppressed",
	"embargoed",
	"members_only",
	"no_grant",
	"locked",
]);

const pick = (value, allowed, fallback) =>
	allowed.includes(value) ? value : fallback;
let preset = pick(
	query.get("preset"),
	DATA.presets.map((p) => p.name),
	DATA.presets[0].name,
);
let year = Number(query.get("year")) || null;
let viewer = pick(query.get("viewer"), Object.keys(VIEWERS), "owner");
let tab = query.get("tab");
let theme = pick(query.get("theme"), ["light", "dark"], null);
if (query.has("embed")) root.classList.add("embed");

const esc = (text) =>
	String(text)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
const titleOf = (doc, id) =>
	DATA.titles[id] ?? doc.meta[id]?.title ?? id.replaceAll("_", " ");

// ---- Figures, as the document's KpiFormat says (kpi-document-types.ts)
const units = (cents, decimals) =>
	(Math.abs(cents) / 100).toLocaleString("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
const money = (cents, symbol, decimals) =>
	`${cents < 0 ? "−" : ""}${symbol}${decimals ? units(cents, 2) : Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
const numberText = (value, meta, symbol) => {
	if (meta.format === "money") return money(value, symbol, 2);
	if (meta.format === "money0") return money(value, symbol, 0);
	if (meta.format === "percent1") return `${(value * 100).toFixed(1)}%`;
	return value.toLocaleString("en-US");
};
const cellText = (cell, meta, symbol) => {
	if (typeof cell === "number") return numberText(cell, meta, symbol);
	if (cell == null) return "Not computed";
	if ("lt" in cell)
		return meta.kind === "count"
			? `<${cell.lt}`
			: `under ${money(cell.lt, symbol, 0)}`;
	if ("approx" in cell) return `about ${cell.approx}`;
	return cell.text;
};
const cellWhy = (cell) =>
	cell && typeof cell === "object" ? (cell.why ?? "") : "";
const axisText = (value, kind, symbol) => {
	if (kind === "rate") return `${Math.round(value * 100)}%`;
	if (kind !== "money") return value.toLocaleString("en-US");
	const whole = Math.abs(value) / 100;
	const short =
		whole >= 1000
			? `${(whole / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`
			: Math.round(whole).toLocaleString("en-US");
	return `${value < 0 ? "−" : ""}${symbol}${short}`;
};

// ---- Charts: the mockup's SVG bars and lines; a cell that is not a number is not drawn, and a hidden one is hatched
const tip = document.getElementById("tip");
const hook = (container) => {
	for (const target of container.querySelectorAll("[data-h]")) {
		target.onmousemove = (event) => {
			tip.innerHTML = target.dataset.h;
			tip.style.display = "block";
			const box = tip.getBoundingClientRect();
			let x = event.clientX + 12;
			let y = event.clientY + 12;
			if (x + box.width > innerWidth) x = event.clientX - box.width - 12;
			if (y + box.height > innerHeight) y = event.clientY - box.height - 12;
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		};
		target.onmouseleave = () => {
			tip.style.display = "none";
		};
	}
};
const nice = (span) => {
	if (span <= 0) return 1;
	const exponent = 10 ** Math.floor(Math.log10(span));
	const fraction = span / exponent;
	return (
		(fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * exponent
	);
};
const chart = ({ labels, series, stack, line, kind, symbol, label }) => {
	const width = 340;
	const height = 140;
	const left = 40;
	const right = 4;
	const top = 6;
	const bottom = 16;
	const count = labels.length;
	const value = (s, i) => (typeof s.cells[i] === "number" ? s.cells[i] : null);
	let high = 0;
	let low = 0;
	labels.forEach((_, i) => {
		let up = 0;
		let down = 0;
		for (const s of series) {
			const v = value(s, i) ?? 0;
			if (stack) {
				if (v > 0) up += v;
				else down += v;
			} else {
				up = Math.max(up, v);
				down = Math.min(down, v);
			}
		}
		high = Math.max(high, up);
		low = Math.min(low, down);
	});
	const step = nice((high - low) / 3 || (kind === "rate" ? 0.01 : 1));
	high = Math.ceil(high / step) * step || step;
	low = Math.floor(low / step) * step;
	const y = (v) => top + ((high - v) / (high - low)) * (height - top - bottom);
	const band = (width - left - right) / count;
	const x = (i) => left + (i + 0.5) * band;
	let out = "";
	for (let v = low; v <= high + step / 1e6; v += step)
		out += `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--bd)" ${Math.abs(v) < step / 1e6 ? "" : 'stroke-dasharray="2 3"'}/><text x="${left - 4}" y="${y(v) + 3}" text-anchor="end">${esc(axisText(v, kind, symbol))}</text>`;
	const every = Math.ceil(count / 7);
	labels.forEach((text, i) => {
		if (i % every === 0)
			out += `<text x="${x(i)}" y="${height - 3}" text-anchor="middle">${esc(text)}</text>`;
	});
	labels.forEach((_, i) => {
		const hidden = series.some((s) => {
			const cell = s.cells[i];
			return (
				cell &&
				typeof cell === "object" &&
				(HATCHED.has(cell.hidden) || "lt" in cell || "approx" in cell)
			);
		});
		if (hidden)
			out += `<rect x="${x(i) - band * 0.35}" y="${top}" width="${band * 0.7}" height="${y(low) - top}" fill="url(#hatch)" rx="2"/>`;
	});
	if (line)
		for (const s of series) {
			let points = [];
			const flush = () => {
				if (points.length > 1)
					out += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${points.join(" ")}"/>`;
				else if (points.length === 1) {
					const [cx, cy] = points[0].split(",");
					out += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${s.color}"/>`;
				}
				points = [];
			};
			labels.forEach((_, i) => {
				const v = value(s, i);
				if (v === null) flush();
				else points.push(`${x(i)},${y(v)}`);
			});
			flush();
		}
	else
		labels.forEach((_, i) => {
			let up = 0;
			let down = 0;
			const barWidth = band * (stack ? 0.62 : 0.7 / series.length);
			series.forEach((s, j) => {
				const v = value(s, i);
				if (v === null || v === 0) return;
				const bx = stack
					? x(i) - barWidth / 2
					: x(i) - band * 0.35 + j * barWidth;
				if (!stack) {
					out += `<rect x="${bx}" y="${Math.min(y(v), y(0))}" width="${barWidth * 0.9}" height="${Math.abs(y(v) - y(0))}" fill="${s.color}" rx="1.5"/>`;
				} else if (v > 0) {
					out += `<rect x="${bx}" y="${y(up + v)}" width="${barWidth}" height="${Math.max(0, y(up) - y(up + v) - (up > 0 ? 1.5 : 0))}" fill="${s.color}" rx="1.5"/>`;
					up += v;
				} else {
					out += `<rect x="${bx}" y="${y(down) + (down < 0 ? 1.5 : 0)}" width="${barWidth}" height="${Math.max(0, y(down + v) - y(down) - (down < 0 ? 1.5 : 0))}" fill="${s.color}" rx="1.5"/>`;
					down += v;
				}
			});
		});
	labels.forEach((text, i) => {
		const lines = series
			.map((s) => {
				const why = cellWhy(s.cells[i]);
				return `${esc(s.name)}: ${esc(cellText(s.cells[i], s.meta, symbol))}${why ? ` (${esc(why)})` : ""}`;
			})
			.join("<br>");
		out += `<rect x="${x(i) - band / 2}" y="${top}" width="${band}" height="${height - top - bottom}" fill="transparent" data-h="${esc(`<b>${esc(text)}</b><br>${lines}`)}"/>`;
	});
	const legend =
		series.length > 1
			? series
					.map((s) => `<i style="background:${s.color}"></i>${esc(s.name)}`)
					.join("")
			: "";
	return `<div class="leg">${legend}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${out}</svg>`;
};
const box = (title, source, body) =>
	`<div class="box"><h3>${esc(title)}<span class="src">${esc(source)}</span></h3>${body}</div>`;

// ---- One tab of one document
const tabOf = (meta) =>
	TABS.find((t) => t.classes.includes(meta.kpiClass))?.id ?? "other";
const render = () => {
	const current = DATA.presets.find((p) => p.name === preset);
	const years = current.years.map((y) => y.year);
	if (!years.includes(year)) year = years.at(-1);
	const entry = current.years.find((y) => y.year === year).documents[viewer];
	const doc = entry.document;
	const table = doc.tables[doc.grain];
	// A period that has not begun at the document's clock is left out (governance marks it embargoed, owner future).
	const today = doc.asOf.slice(0, 10);
	const shown = table.periods.flatMap((period, index) => {
		const info = doc.periods.find((p) => p.period === period);
		const begun = info && info.state !== "future" && info.from <= today;
		return begun || !info ? [{ index, info, period }] : [];
	});
	const labels = shown.map(({ info, period }) =>
		info ? info.label.replace(/ \d{4}$/, "") : period,
	);
	const symbol = doc.symbol;
	const ids = Object.keys(doc.meta).filter((id) => table.series[id]);
	const tabs = [...TABS];
	if (ids.some((id) => tabOf(doc.meta[id]) === "other"))
		tabs.push({ id: "other", title: "Other" });
	if (!tabs.some((t) => t.id === tab)) tab = tabs[0].id;
	const inTab = ids.filter((id) => tabOf(doc.meta[id]) === tab);
	const cellsOf = (id) => shown.map(({ index }) => table.series[id][index]);
	const seriesOf = (id, color) => ({
		name: titleOf(doc, id),
		meta: doc.meta[id],
		cells: cellsOf(id),
		color,
	});
	// The headline period: the last one shown and closed, else the last one shown.
	const head =
		[...shown]
			.reverse()
			.find(({ info }) => info?.state === "shown" && !info.open) ??
		shown.at(-1);
	const headLabel = head?.info?.label ?? head?.period ?? "";
	const before = shown[shown.indexOf(head) - 1];
	const beforeLabel = before?.info?.label.replace(/ \d{4}$/, "") ?? "";

	const singles = inTab.filter((id) => !id.includes(":"));
	const tiles = singles.slice(0, 4).map((id) => {
		const meta = doc.meta[id];
		const cell = head ? table.series[id][head.index] : null;
		const change = head ? table.changes?.[id]?.[head.index] : null;
		let sub = headLabel;
		if (typeof cell === "number" && typeof change === "number" && beforeLabel)
			sub =
				change === 0
					? `${headLabel} · same as ${beforeLabel}`
					: `${headLabel} · ${change > 0 ? "▲" : "▼"} ${numberText(Math.abs(change), meta, symbol)} vs ${beforeLabel}`;
		else if (cellWhy(cell)) sub = `${headLabel} · ${cellWhy(cell)}`;
		const plain = typeof cell === "number";
		return `<div class="tile"><span>${esc(titleOf(doc, id))}</span><b class="${plain ? "" : "h"}">${esc(cellText(cell, meta, symbol))}</b><span>${esc(sub)}</span></div>`;
	});

	const source = "atm KPI document";
	const range = `${labels[0] ?? ""} to ${labels.at(-1) ?? ""} ${year}`;
	const boxes = [];
	const rates = singles.filter((id) => doc.meta[id].kind === "rate");
	for (const id of singles.filter((id) => doc.meta[id].kind !== "rate")) {
		const meta = doc.meta[id];
		const title = titleOf(doc, id);
		boxes.push(
			box(
				title,
				source,
				chart({
					labels,
					line: meta.kpiClass === "people" && meta.kind === "count",
					kind: meta.kind,
					symbol,
					label: `${title}, ${range}`,
					series: [seriesOf(id, COLORS[boxes.length % COLORS.length])],
				}),
			),
		);
	}
	const groups = [
		...new Set(
			inTab.filter((id) => id.includes(":")).map((id) => id.split(":")[0]),
		),
	];
	for (const group of groups) {
		const members = inTab.filter((id) => id.startsWith(`${group}:`));
		// One kind of income is the org's own word for it ("Giving" for the church), not a split.
		const title =
			members.length === 1
				? titleOf(doc, members[0])
				: (GROUPS[group] ?? group.replaceAll("_", " "));
		boxes.push(
			box(
				title,
				source,
				chart({
					labels,
					stack: true,
					kind: doc.meta[members[0]].kind,
					symbol,
					label: `${title}, ${range}`,
					series: members.map((id, i) =>
						seriesOf(id, COLORS[i % COLORS.length]),
					),
				}),
			),
		);
	}
	if (rates.length) {
		const title = rates.map((id) => titleOf(doc, id)).join(" and ");
		boxes.push(
			box(
				title,
				source,
				chart({
					labels,
					line: true,
					kind: "rate",
					symbol,
					label: `${title}, ${range}`,
					series: rates.map((id, i) => seriesOf(id, COLORS[i % COLORS.length])),
				}),
			),
		);
	}

	document.getElementById("note").textContent = [
		`${labels[0] ?? ""} to ${labels.at(-1) ?? ""} ${year}`,
		`${current.members.toLocaleString("en-US")} ${DATA.words.holder.other} simulated`,
		`${doc.basis} basis`,
		`${VIEWERS[viewer]} view`,
		`as of ${doc.asOf.slice(0, 10)}`,
	].join(" · ");
	document.getElementById("tiles").innerHTML = tiles.join("");
	const grid = document.getElementById("grid");
	grid.innerHTML = boxes.length
		? boxes.join("")
		: `<div class="box wide"><div class="lock">Nothing in this tab for this viewer.</div></div>`;
	hook(grid);

	const notComputed = doc.notComputed
		.map((item) => `${esc(item.reason)}.`)
		.join(" ");
	document.getElementById("foot").innerHTML = [
		`<p><b>Demo, synthetic data.</b> ${esc(DATA.name)} is invented (${esc(DATA.label)}); every name and number is generated. Figures are atm's KPI document for this viewer, built from the simulated events; hatched means hidden for this viewer.</p>`,
		`<p>${esc(doc.captions[String(year)] ?? "")}</p>`,
		notComputed ? `<p>Not computed yet: ${notComputed}</p>` : "",
		`<p>Preset <code>${esc(current.name)}</code>, seed ${current.seed} · kpis hash <code>${current.kpisHash.slice(0, 12)}</code> · fixture hash <code>${current.fixtureHash.slice(0, 12)}</code> · document sha256 <code>${entry.hash.slice(0, 12)}</code></p>`,
	].join("");

	const presetSelect = document.getElementById("prof");
	presetSelect.innerHTML = DATA.presets
		.map(
			(p) =>
				`<option value="${esc(p.name)}"${p.name === preset ? " selected" : ""}>${esc(p.label)}</option>`,
		)
		.join("");
	presetSelect.disabled = DATA.presets.length < 2;
	const yearSelect = document.getElementById("year");
	yearSelect.style.display = years.length > 1 ? "" : "none";
	yearSelect.innerHTML = years
		.map((y) => `<option${y === year ? " selected" : ""}>${y}</option>`)
		.join("");
	document.getElementById("viewers").innerHTML = Object.entries(VIEWERS)
		.map(
			([id, name]) =>
				`<button type="button" data-v="${id}" class="${id === viewer ? "on" : ""}" aria-pressed="${id === viewer}">${name}</button>`,
		)
		.join(" ");
	document.getElementById("tabs").innerHTML = tabs
		.map(
			(t) =>
				`<button type="button" data-t="${t.id}" class="${t.id === tab ? "on" : ""}" aria-pressed="${t.id === tab}">${esc(t.title)}</button>`,
		)
		.join(" ");
	for (const button of document.querySelectorAll("#viewers button"))
		button.onclick = () => {
			viewer = button.dataset.v;
			render();
		};
	for (const button of document.querySelectorAll("#tabs button"))
		button.onclick = () => {
			tab = button.dataset.t;
			render();
		};
	if (parent !== window)
		parent.postMessage(
			{ type: "tfd-demo:height", height: root.scrollHeight },
			"*",
		);
};

// ---- Theme: ?theme=, else the reader's preference; the button flips it
const dark = () =>
	theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
const paintTheme = () => {
	if (theme) root.dataset.theme = theme;
	const button = document.getElementById("theme");
	button.textContent = dark() ? "Light theme" : "Dark theme";
};
document.getElementById("theme").onclick = () => {
	theme = dark() ? "light" : "dark";
	paintTheme();
};
document.getElementById("prof").onchange = (event) => {
	preset = event.target.value;
	year = null;
	render();
};
document.getElementById("year").onchange = (event) => {
	year = Number(event.target.value);
	render();
};
paintTheme();
render();
