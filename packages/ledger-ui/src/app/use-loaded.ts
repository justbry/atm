import { useEffect, useRef, useState } from "preact/hooks";

/** A read the Reader rejected leaves its pane as it is, still loading: the rejection is answered here, so it is never
 * left unhandled. */
export const keepLoading = (): void => undefined;

/** What `load` answers for the current `key`: null while it is on its way, and for a key that has changed since.
 * `change` swaps in a newer value for the same key, such as the list after a write the Writer has answered. `load` is
 * called again only when `key` changes, so the key must name everything `load` reads. */
export function useLoaded<Value>(
	key: string,
	load: () => Promise<Value>,
): [Value | null, (update: (current: Value) => Value) => void] {
	const [loaded, setLoaded] = useState<{ key: string; value: Value } | null>(
		null,
	);
	const latest = useRef(load);
	latest.current = load;
	useEffect(() => {
		let current = true;
		latest.current().then((value) => {
			if (current) setLoaded({ key, value });
		}, keepLoading);
		return () => {
			current = false;
		};
	}, [key]);
	return [
		loaded?.key === key ? loaded.value : null,
		(update) =>
			setLoaded((previous) =>
				previous?.key === key
					? { key, value: update(previous.value) }
					: previous,
			),
	];
}
