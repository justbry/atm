import { useEffect, useRef, useState } from "preact/hooks";

/** A read the Reader rejected leaves its pane as it is, still loading: the rejection is answered here, so it is never
 * left unhandled. */
export const keepLoading = (): void => undefined;

/** Whether the read for the current key was rejected, and how to read it again. */
export type LoadStatus = { failed: boolean; retry: () => void };

/** What `load` answers for the current `key`: null while it is on its way, and for a key that has changed since.
 * `change` swaps in a newer value for the same key, such as the list after a write the Writer has answered. `load` is
 * called again only when `key` changes, so the key must name everything `load` reads. If the read is rejected, the
 * status says so (the pane shows its error state) and `retry` reads again. */
export function useLoaded<Value>(
	key: string,
	load: () => Promise<Value>,
): [Value | null, (update: (current: Value) => Value) => void, LoadStatus] {
	const [loaded, setLoaded] = useState<{ key: string; value: Value } | null>(
		null,
	);
	const [failedKey, setFailedKey] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const latest = useRef(load);
	latest.current = load;
	useEffect(() => {
		let current = true;
		latest.current().then(
			(value) => {
				if (current) setLoaded({ key, value });
			},
			() => {
				if (current) setFailedKey(key);
			},
		);
		return () => {
			current = false;
		};
	}, [key, attempt]);
	return [
		loaded?.key === key ? loaded.value : null,
		(update) =>
			setLoaded((previous) =>
				previous?.key === key
					? { key, value: update(previous.value) }
					: previous,
			),
		{
			failed: failedKey === key,
			retry: () => {
				setFailedKey(null);
				setAttempt((before) => before + 1);
			},
		},
	];
}
