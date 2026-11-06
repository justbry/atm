// Generates plans/ledger-ui/loop/parity-checklist.md, the feature checklist reviewers score parity against (protocol v9
// addendum §2), by driving the mockup headless in happy-dom, as s0-text.mjs does.
// Usage: bun plans/ledger-ui/loop/tools/parity-checklist.mjs [mockup.html] [out.md]
// happy-dom comes from /tmp/ledger-smoke/node_modules unless HAPPY_DOM names another entry file.
// Every line: an id, the slice that owns it, what it is, and how to see it in the mockup. Deterministic: the crawl
// order is the mockup's DOM order, school by school and tab by tab; ids are slugs, with -2, -3 on repeats.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { Window } = await import(
	process.env.HAPPY_DOM ??
		"/tmp/ledger-smoke/node_modules/happy-dom/lib/index.js"
);
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const mockupPath =
	process.argv[2] ?? `${repo}plans/ledger-ui/design/mockup.html`;
const outPath =
	process.argv[3] ?? `${repo}plans/ledger-ui/loop/parity-checklist.md`;
const html = readFileSync(mockupPath, "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/);
const win = new Window({
	url: "https://localhost/",
	console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
});
win.document.write(html.replace(script[0], ""));
await win.happyDOM.waitUntilComplete();
win.eval(`${script[1]}\n;window.__t={SC}`);
const d = win.document;
const $ = (s) => d.querySelector(s);
const $$ = (s, root = d) => [...root.querySelectorAll(s)];
const n = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const short = (s, max = 90) => {
	const t = n(s);
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const SC = win.__t.SC;
const schoolIds = Object.keys(SC);
const schoolName = (id) => SC[id]?.name ?? id;
const crawlErrors = [];
const attempt = (what, action) => {
	try {
		action();
	} catch (error) {
		crawlErrors.push(`${what}: ${error.message}`);
	}
};
const pressEscape = () => {
	d.body.dispatchEvent(
		new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
	);
};
const click = (selector) => {
	const element = typeof selector === "string" ? $(selector) : selector;
	if (!element) throw new Error(`no ${selector}`);
	element.click();
	return element;
};
const sc = (id) => {
	click("#sw");
	click(`[data-sc=${id}]`);
};
const TABS = $$(".tab").map((t) => ({
	p: t.dataset.p,
	label: n(
		[...t.childNodes]
			.filter((c) => c.nodeType === 3)
			.map((c) => c.textContent)
			.join(""),
	),
}));
const tabLabel = (p) => TABS.find((t) => t.p === p)?.label ?? p;
const tab = (p) => click(`.tab[data-p=${p}]`);
const TAB_SLICE = {
	pl: "S3",
	dash: "S1",
	mem: "S4",
	bk: "S2",
	cod: "S5",
	led: "S5",
	rep: "S5",
};
const OPEN_CLASSES = ["pane", "pop", "menu", "drawer", "bg"];
const visible = (element) => {
	for (let e = element; e && e !== d.body; e = e.parentElement) {
		if (e.hidden) return false;
		if (
			OPEN_CLASSES.some((c) => e.classList?.contains(c)) &&
			!e.classList.contains("on")
		)
			return false;
	}
	return true;
};
const PERIODISH =
	/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$|^\d{4}$|^Q\d \d{4}$|^\d{1,2}$|^[‹›]$/;
const ID_LIKE =
	/^(m|s|u|h)_\w+$|^(pay|in|prod|price)_|^-?\d+$|^\d{4}(Q\d)?$|^tiers:|^addons:/;
/** Text with a space between elements, so "All schools" and its count do not run together. */
const textOf = (e) => {
	const parts = [];
	const walk = (node) => {
		for (const c of node.childNodes) {
			if (c.nodeType === 3) parts.push(c.textContent);
			else if (c.nodeType === 1 && c.tagName !== "svg") {
				parts.push(" ");
				walk(c);
				parts.push(" ");
			}
		}
	};
	walk(e);
	return n(parts.join(""));
};
const label = (e) =>
	short(
		textOf(e) ||
			e.getAttribute("aria-label") ||
			e.title ||
			e.getAttribute("placeholder") ||
			e.value ||
			"",
		60,
	);
const dataKey = (e) => {
	for (const a of e.attributes) {
		if (
			!a.name.startsWith("data-") ||
			["data-ic", "data-id", "data-toast"].includes(a.name)
		)
			continue;
		return a.value === ""
			? a.name
			: `${a.name}=${ID_LIKE.test(a.value) ? "*" : a.value}`;
	}
	return e.id ? `#${e.id}` : "";
};
const kind = (e) => {
	if (e.tagName === "INPUT") return `${e.type || "text"} field`;
	if (e.tagName === "SELECT") return "select";
	if (e.tagName === "TEXTAREA") return "text area";
	if (e.tagName === "A") return "link";
	if (e.getAttribute("role") === "menuitem") return "menu item";
	if (e.getAttribute("role") === "option") return "option";
	if (e.classList.contains("chip")) return "chip";
	return "button";
};
const describe = (e) => {
	const k = kind(e);
	let text = label(e);
	if (PERIODISH.test(text)) text = "a period";
	const options =
		e.tagName === "SELECT"
			? ` (options: ${short(
					$$("option", e)
						.map((o) => n(o.textContent))
						.join(", "),
					120,
				)})`
			: "";
	const row = e.closest("tr") && !e.closest("thead") ? "row " : "";
	const key = dataKey(e);
	const state = e.disabled
		? `, disabled${e.title ? `: ${short(e.title, 70)}` : ""}`
		: "";
	return `${row}${k} "${text}"${key ? ` [${key}]` : ""}${options}${state}`;
};
const CONTROLS =
	"button,input,select,textarea,a[href],.chip,[role=tab],[role=menuitem],[role=option]";

const items = [];
const seen = new Set();
const add = (slice, area, what, how) => {
	const key = `${slice}|${area}|${what}`;
	if (seen.has(key)) return;
	seen.add(key);
	items.push({ slice, area, what, how });
};
const crawl = (root, slice, area, how) => {
	for (const e of $$(CONTROLS, root))
		if (visible(e)) add(slice, area, describe(e), how);
};
const STATE_SELECTORS =
	".kempty,.klock,.kwaitbox,.banner,.err,.lock,.kscope,.note,[id$=empty],.vabanner,.kcaption";
const states = (root, slice, area, how) => {
	for (const e of $$(STATE_SELECTORS, root))
		if (visible(e) && n(e.textContent))
			add(slice, area, `state: "${short(e.textContent, 110)}"`, how);
};

// S0: the frame
add(
	"S0",
	"shell",
	`brand "${n($(".logo")?.textContent)}" in the top bar`,
	"any school",
);
for (const t of TABS)
	add(
		"S0",
		"shell",
		`tab "${t.label}" [data-p=${t.p}]`,
		"any school, the tabs row",
	);
for (const id of schoolIds)
	attempt(`badges ${id}`, () => {
		sc(id);
		for (const t of $$(".tab")) {
			const b = t.querySelector(".badge");
			if (b && visible(b))
				add(
					"S0",
					"shell",
					`tab badge "${n(b.textContent)}" on ${tabLabel(t.dataset.p)}`,
					`school ${schoolName(id)}`,
				);
		}
		const banner = $("#bnr");
		if (banner && visible(banner))
			add(
				"S0",
				"shell",
				`stale banner "${short(banner.textContent)}"`,
				`school ${schoolName(id)}`,
			);
	});
attempt("switcher", () => {
	sc("vol");
	click("#sw");
	add(
		"S0",
		"shell",
		`school switcher button "${label($("#sw"))}"`,
		"top bar, left",
	);
	for (const e of $$(CONTROLS, $("#sp")))
		add("S0", "shell", `switcher ${describe(e)}`, "top bar → school switcher");
	pressEscape();
});
attempt("help", () => {
	click("#hb");
	for (const e of $$(CONTROLS, $("#hp")))
		add(
			"S0",
			"shell",
			`help menu ${describe(e)}`,
			"top bar → ? (Help and SDK)",
		);
	pressEscape();
});
attempt("all schools", () => {
	sc("all");
	for (const th of $$("#all thead th"))
		add(
			"S0",
			"all-schools",
			`column "${n(th.textContent)}"`,
			"school switcher → All schools",
		);
	states($("#all"), "S0", "all-schools", "school switcher → All schools");
});

// S7: the top bar's View as, period control and preview banner (orchestrator, 2026-11-06)
for (const id of schoolIds)
	attempt(`view as ${id}`, () => {
		sc(id);
		tab("dash");
		const button = $("#kview");
		if (!button || !visible(button)) return;
		add(
			"S7",
			"view-as",
			`View as button "${label(button)}"`,
			`school ${schoolName(id)}, top bar`,
		);
		click(button);
		for (const e of $$("#kvp .it,#kvp [data-bv],#kvp button", d))
			add(
				"S7",
				"view-as",
				`View as ${describe(e)}`,
				`school ${schoolName(id)} → View as`,
			);
		pressEscape();
	});
attempt("preview banner", () => {
	sc("vol");
	tab("dash");
	click("#kview");
	click("#kvp [data-bv=governance]");
	for (const e of $$("#vax", d))
		add(
			"S7",
			"view-as",
			`preview banner exit ${describe(e)}`,
			"Vibes of Light → View as → Governance",
		);
	states(d.body, "S7", "view-as", "Vibes of Light → View as → Governance");
	click("#vax");
});
for (const p of ["dash", "bk"])
	attempt(`period ${p}`, () => {
		sc("b4u");
		tab(p);
		click("#pb");
		add(
			"S7",
			"period",
			`period button on ${tabLabel(p)} "${label($("#pb"))}"`,
			`B4 Uni › ${tabLabel(p)}, top bar`,
		);
		for (const e of $$(CONTROLS, $("#pp")))
			if (visible(e))
				add(
					"S7",
					"period",
					`period popover on ${tabLabel(p)}: ${describe(e)}`,
					`B4 Uni › ${tabLabel(p)} → period button`,
				);
		pressEscape();
	});

// Every school × tab, as the signed-in person
for (const id of schoolIds)
	for (const t of TABS)
		attempt(`pane ${id} ${t.p}`, () => {
			sc(id);
			tab(t.p);
			const pane = $(`#${t.p}`);
			crawl(pane, TAB_SLICE[t.p], t.p, `${schoolName(id)} › ${t.label}`);
			states(pane, TAB_SLICE[t.p], t.p, `${schoolName(id)} › ${t.label}`);
		});

// Audiences: the Dashboard per audience is S1b; what each other tab gates goes to that tab's slice
attempt("audiences", () => {
	for (const id of ["b4u", "vol"]) {
		sc(id);
		tab("dash");
		click("#kview");
		const audiences = $$("#kvp [data-bv]")
			.filter((b) => !b.disabled)
			.map((b) => ({
				key: b.dataset.bv,
				name: short(b.querySelector("b")?.textContent || label(b), 30),
			}));
		pressEscape();
		for (const audience of audiences) {
			click("#kview");
			click(`#kvp [data-bv=${audience.key}]`);
			for (const t of TABS) {
				tab(t.p);
				const pane = $(`#${t.p}`);
				const slice = t.p === "dash" ? "S1b" : TAB_SLICE[t.p];
				const how = `${schoolName(id)} › ${t.label} → View as ${audience.name}`;
				if (t.p === "dash") {
					const strip = $$(".kmonths button", pane)
						.map((b) => n(b.textContent))
						.filter((x) => !/^[‹›]$/.test(x));
					add(
						slice,
						"audience",
						`${audience.name}: ${$$(".kcard", pane).length} cards, periods ${short(strip.join(" "), 60) || "none"}`,
						how,
					);
				}
				for (const e of $$(".klock h4,.khid", pane))
					if (visible(e))
						add(
							slice,
							"audience",
							`${audience.name} gate: "${short(e.textContent, 80)}"`,
							how,
						);
				states(pane, slice, "audience", how);
			}
			if ($("#vax")) click("#vax");
		}
	}
});

// Dashboard views, scenarios and charts (S1)
attempt("dashboard", () => {
	sc("b4u");
	tab("dash");
	for (const key of $$("#dash [data-dv]").map((e) => e.dataset.dv)) {
		const e = click(`#dash [data-dv=${key}]`);
		const how = `B4 Uni › Dashboard → ${label(e)}`;
		for (const svg of $$("#dash svg[aria-label]"))
			add(
				"S1",
				"dash",
				`chart "${short(svg.getAttribute("aria-label"), 60)}" (${label(e)} view)`,
				how,
			);
		for (const h of $$("#dash .kcard small"))
			add("S1", "dash", `card "${n(h.textContent)}" (${label(e)} view)`, how);
	}
	for (const key of $$("#dash [data-dsc]").map((e) => e.dataset.dsc)) {
		const e = click(`#dash [data-dsc=${key}]`);
		states(
			$("#dash"),
			"S1",
			"dash",
			`B4 Uni › Dashboard → scenario ${label(e)}`,
		);
	}
});

// Members: ⋯ menu, drawer, role actions and modals (S4)
for (const id of ["vol", "b4u"])
	attempt(`members ${id}`, () => {
		sc(id);
		tab("mem");
		for (const chip of $$(
			"#mb .krole,#mb .kfin,#mb .kfam,#mb [class*=kbk-],#mb .knoplan",
		))
			add(
				"S4",
				"members",
				`row chip "${short(chip.textContent, 40)}" (.${chip.className.split(" ").join(".")})`,
				`${schoolName(id)} › Members`,
			);
		const rows = $$("#mb tr.row");
		for (const row of rows.slice(0, 3)) {
			const trigger = row.querySelector("[data-kmenu]");
			if (!trigger) continue;
			click(trigger);
			for (const e of $$("#kmm [role=menuitem]"))
				add(
					"S4",
					"menu",
					`⋯ ${describe(e)}`,
					`${schoolName(id)} › Members → ⋯ on a row`,
				);
			pressEscape();
		}
		const first = rows[0];
		if (first) {
			click(first);
			for (const h of $$("#dr h3,#dr h4,#dr h5"))
				add(
					"S4",
					"drawer",
					`drawer section "${short(h.textContent, 50)}"`,
					`${schoolName(id)} › Members → click a row`,
				);
			crawl(
				$("#dr"),
				"S4",
				"drawer",
				`${schoolName(id)} › Members → click a row`,
			);
			pressEscape();
		}
		const owner = rows.find((r) => r.querySelector("[data-kmenu]"));
		for (const act of ["invoice", "adjust", "refund"]) {
			if (!owner) break;
			click(owner.querySelector("[data-kmenu]"));
			const item = $(`#kmm [data-act=${act}]`);
			if (item && !item.disabled) {
				click(item);
				add(
					"S4",
					"modal",
					`modal "${short($("#md h3")?.textContent, 60)}"`,
					`${schoolName(id)} › Members → ⋯ → ${label(item)}`,
				);
				crawl(
					$("#md"),
					"S4",
					"modal",
					`${schoolName(id)} › Members → ⋯ → ${label(item)}`,
				);
			}
			pressEscape();
		}
	});

// Member portal (S6)
attempt("portal", () => {
	sc("b4u");
	tab("mem");
	const eye = $("#mb [data-vm]");
	click(eye);
	for (const key of $$("#vm [data-vtab]").map((e) => e.dataset.vtab)) {
		const t = click(`#vm [data-vtab=${key}]`);
		const how = `B4 Uni › Members → eye on a member → ${label(t)}`;
		crawl($("#vm"), "S6", "portal", how);
		states($("#vm"), "S6", "portal", how);
	}
	for (const key of $$("#vm [data-vfam]").map((e) => e.dataset.vfam)) {
		const f = click(`#vm [data-vfam=${key}]`);
		states(
			$("#vm"),
			"S6",
			"portal",
			`B4 Uni › Members → eye → family toggle ${label(f)}`,
		);
	}
	if ($("#vmx")) click("#vmx");
});

// Plans: modes, editor, review (S3)
attempt("plans", () => {
	sc("vol");
	tab("pl");
	for (const key of $$("#pl [data-pmode]").map((e) => e.dataset.pmode)) {
		const m = click(`#pl [data-pmode=${key}]`);
		crawl($("#pl"), "S3", "plans", `Vibes of Light › Plans → ${label(m)}`);
		states($("#pl"), "S3", "plans", `Vibes of Light › Plans → ${label(m)}`);
	}
	click("#pl [data-pmode=edit]");
	const tier = $("#pl tr[data-pe]");
	if (tier) {
		click(tier);
		for (const l of $$("#pe label"))
			add(
				"S3",
				"editor",
				`editor field "${short(l.textContent, 50)}"`,
				"Vibes of Light › Plans → click a tier",
			);
		crawl($("#pe"), "S3", "editor", "Vibes of Light › Plans → click a tier");
		if ($("#pcancel")) click("#pcancel");
	}
});

// Settings drawer (S7; its appearance section belongs to S0's drawer)
for (const id of ["vol", "b4u"])
	attempt(`settings ${id}`, () => {
		sc(id);
		click("#gb");
		let section = "";
		for (const e of $$(
			"#set h3,#set h4,#set h5," +
				CONTROLS.split(",")
					.map((c) => `#set ${c}`)
					.join(","),
		)) {
			if (/^H[345]$/.test(e.tagName)) {
				section = short(e.textContent, 40);
				continue;
			}
			if (!visible(e)) continue;
			const slice = /appearance|theme/i.test(section) ? "S0" : "S7";
			add(
				slice,
				"settings",
				`${section ? `${section}: ` : ""}${describe(e)}`,
				`${schoolName(id)} → gear (Settings)`,
			);
		}
		if ($("#setx")) click("#setx");
		else pressEscape();
	});

// Keyboard paths, from the mockup's keydown handlers (static)
const KEY_CONTEXT = [
	[/kMenu|kmm/, "S4", "Members ⋯ menu"],
	[
		/listbox|lb\b|closeP\(\);const b=lb/,
		"S0",
		"top-bar listboxes (schools; View as is S7)",
	],
	[/closeM\(\)/, "S0", "modal, popovers, plan editor and member portal"],
	[/pcard/, "S3", "Plans preview: a plan card"],
	[/pcode/, "S3", "Plans preview: the promo code field"],
];
script[1].split("\n").forEach((line, index) => {
	const keys = [
		...new Set([...line.matchAll(/e\.key==="(\w+)"/g)].map((x) => x[1])),
	];
	if (!keys.length) return;
	const lineNumber =
		html.slice(0, html.indexOf(script[1])).split("\n").length + index;
	const [, slice, context] = KEY_CONTEXT.find(([re]) => re.test(line)) ?? [
		null,
		"S0",
		"page",
	];
	add(
		slice,
		"keyboard",
		`${keys.join(", ")} in the ${context}`,
		`keyboard; handler at mockup.html line ${lineNumber}`,
	);
});

// Output
const ORDER = ["S0", "S1", "S0b", "S1b", "S2", "S3", "S4", "S5", "S6", "S7"];
const TITLES = {
	S0: "shell",
	S1: "Dashboard",
	S0b: "View as and period delta",
	S1b: "audiences on the Dashboard",
	S2: "Bookings",
	S3: "Plans",
	S4: "Members",
	S5: "Ledger, Reports, Promos",
	S6: "member portal",
	S7: "Settings, View as, period control, preview banner",
};
const slug = (s) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56)
		.replace(/-+$/, "");
const ids = new Map();
const lines = [];
for (const slice of ORDER) {
	const own = items.filter((i) => i.slice === slice);
	if (!own.length) continue;
	lines.push("", `## ${slice}: ${TITLES[slice]} (${own.length})`, "");
	for (const i of own) {
		const base = `${slice}-${i.area}-${slug(i.what)}`;
		const count = (ids.get(base) ?? 0) + 1;
		ids.set(base, count);
		lines.push(
			`- \`${count > 1 ? `${base}-${count}` : base}\` ${i.what.replace(/\|/g, "/")}. See: ${i.how}.`,
		);
	}
}
const sha = createHash("sha256").update(html).digest("hex");
const counts = ORDER.map(
	(s) => `${s} ${items.filter((i) => i.slice === s).length}`,
).join(", ");
const out = [
	"# Ledger UI feature-parity checklist",
	"",
	`Generated by \`plans/ledger-ui/loop/tools/parity-checklist.mjs\` from \`plans/ledger-ui/design/mockup.html\` (sha256 ${sha.slice(0, 16)}), driven headless in happy-dom; do not edit by hand, regenerate. Reviewers score feature parity (protocol v9 addendum §2) against these lines: each is one tab, control, menu item, state, audience, empty or error state, or keyboard path, with the slice that owns it and how to see it in the mockup. Controls are listed once, at the first school and tab where they show; "a period" stands for every button of a period strip; [data-…] is the mockup's hook, \`*\` an id. The executable counterpart is \`packages/ledger-ui/test/parity/checks.json\`.`,
	"",
	`${items.length} lines: ${counts}.`,
	...lines,
	"",
].join("\n");
writeFileSync(outPath, out);
process.stdout.write(`${outPath}: ${items.length} lines (${counts})\n`);
if (crawlErrors.length)
	process.stderr.write(
		`crawl steps that did not run:\n${crawlErrors.join("\n")}\n`,
	);
