/** DOM text of #app per golden entry after its steps (protocol §8 pack). node dom-dump.mjs --slice S0 --out <dir> */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const { chromium } = createRequire("/tmp/ledger-shots/package.json")("playwright-core");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const slice = argument("--slice");
const out = argument("--out");
const golden = JSON.parse(readFileSync(`packages/ledger-ui/test/golden/${slice}.json`, "utf8"));
const executablePath = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
for (const entry of golden.entries) {
	const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
	await page.goto(`http://localhost:5181/${entry.route}`);
	await page.waitForFunction((hash) => document.getElementById("app")?.dataset.route === hash, entry.route);
	for (const step of entry.steps ?? []) if (step.click) await page.click(step.click, { force: true });
	await page.waitForTimeout(100);
	const text = await page.evaluate(() => document.getElementById("app").innerText);
	writeFileSync(join(out, `${entry.id}.txt`), `${text}\n`);
	await page.close();
}
await browser.close();
process.stdout.write(`${golden.entries.length} dumps\n`);
