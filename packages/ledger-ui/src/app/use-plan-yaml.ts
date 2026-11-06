import { useEffect, useRef } from "preact/hooks";
import type { Menu } from "../data/plans.ts";
import {
	canonical,
	type PlansSession,
	problems,
	withDraft,
} from "./plans-menu.ts";
import { parseMenu } from "./plans-yaml.ts";

const debounceMilliseconds = 250;

/** What the Code view's text needs of the pane: the newest session, a way to replace it, and the Writer's save. */
type YamlHost = {
	latest: { current: PlansSession | undefined };
	commit: (session: PlansSession) => void;
	save: (menu: Menu) => void;
	onToast: (text: string) => void;
};

/**
 * Typing in the Code view (mockup `kApply`, `kFlush`): typed text is kept as it is, and after a pause (or before the
 * pane handles a click, or on blur, `flush`) applied to the draft when it parses and says something new. An applied
 * draft is saved unless it has problems; text that does not parse leaves the draft as it was.
 */
export function usePlanYaml({ latest, commit, save, onToast }: YamlHost): {
	type: (text: string) => void;
	flush: () => void;
	format: () => void;
	/** Drops pending text: the draft is about to be replaced. */
	cancel: () => void;
} {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancel = (): void => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	};
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);

	const apply = (): void => {
		cancel();
		const current = latest.current;
		if (!current || current.yamlText === null) return;
		const parsed = parseMenu(current.yamlText, {
			version: current.version,
			previous: current.draft,
		});
		if (!parsed.ok || canonical(parsed.menu) === canonical(current.draft))
			return;
		commit(withDraft(current, parsed.menu, current.yamlText));
		if (problems(parsed.menu).length === 0) save(parsed.menu);
	};
	return {
		cancel,
		type: (text) => {
			const current = latest.current;
			if (!current) return;
			commit({ ...current, yamlText: text });
			cancel();
			timer.current = setTimeout(apply, debounceMilliseconds);
		},
		flush: () => {
			if (timer.current !== null) apply();
		},
		/** Format: apply what was typed, then show the draft in the standard layout; refused while the text does not parse. */
		format: () => {
			apply();
			const current = latest.current;
			if (!current) return;
			const parsed =
				current.yamlText === null
					? null
					: parseMenu(current.yamlText, {
							version: current.version,
							previous: current.draft,
						});
			if (parsed && !parsed.ok) {
				onToast(`Fix line ${parsed.line} before formatting.`);
				return;
			}
			commit({ ...current, yamlText: null });
			onToast("Formatted.");
		},
	};
}
