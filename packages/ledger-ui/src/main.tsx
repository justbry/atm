import { mountApp } from "./app/mount.tsx";
import { createFixtureReader } from "./fixtures/reader.ts";
import { createFixtureWriter } from "./fixtures/writer.ts";

/** The fixture build: the mockup's clock, schools and an instant Writer. */
const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
const root = document.getElementById("app");
if (root)
	mountApp(root, {
		reader: createFixtureReader({ clock }),
		writer: createFixtureWriter({ mode: "instant" }),
		clock,
	});
