/** DOM text of #app per golden entry after its steps (protocol §8 pack). node dom-dump.mjs --slice S0 --out <dir> [--app <origin>] */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const { chromium } = createRequire("/tmp/ledger-shots/package.json")("playwright-core");
const argument = (name) => {
	const index = process.argv.indexOf(name);
	return index > 0 ? process.argv[index + 1] : undefined;
};
const appOrigin = argument("--app") ?? "http://localhost:5181";
const slice = argument("--slice");
const out = argument("--out");
const golden = JSON.parse(readFileSync(`packages/ledger-ui/test/golden/${slice}.json`, "utf8"));
const executablePath = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
for (const entry of golden.entries) {
	const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
	await page.goto(`${appOrigin}/${entry.route}`);
	await page.waitForFunction(() => document.getElementById("app")?.dataset.route === location.hash);
	for (const step of entry.steps ?? []) {
		if (step.click) await page.click(step.click, { force: true });
		else if (step.fill) await page.locator(step.fill).evaluate((input, value) => {
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		}, step.value);
		else if (step.key) await page.locator(step.target).press(step.key);
	}
	await page.waitForTimeout(100);
	const text = await page.evaluate(() => document.getElementById("app").innerText);
	writeFileSync(join(out, `${entry.id}.txt`), `${text}\n`);
	await page.close();
}
await browser.close();
process.stdout.write(`${golden.entries.length} dumps\n`);
