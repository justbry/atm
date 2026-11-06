import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
	type CsvColumn,
	csvMediaType,
	downloadedToast,
	toCsv,
} from "../data/ledger.ts";
import type { Writer } from "../data/writer.ts";
import { Icon } from "./icon.tsx";

const failedToast = "Could not save the file. Try again.";

/** A CSV download (mockup `kSave`): the one place the books panes make a file. The file is the contract's `toCsv` over
 * the columns and rows; the Writer saves it; the toast counts the rows only once the Writer has answered. While it is
 * pending the button is busy and disabled. */
export function DownloadButton<Row>({
	writer,
	onToast,
	test,
	className,
	title,
	label,
	name,
	columns,
	rows,
}: {
	writer: Writer;
	onToast: (text: string) => void;
	test: string;
	className: string;
	title: string;
	label: string;
	name: string;
	columns: ReadonlyArray<CsvColumn<Row>>;
	rows: ReadonlyArray<Row>;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const save = async (): Promise<void> => {
		setBusy(true);
		try {
			await writer.download({
				name,
				type: csvMediaType,
				text: toCsv(columns, rows),
			});
			onToast(downloadedToast(rows.length));
		} catch {
			onToast(failedToast);
		} finally {
			setBusy(false);
		}
	};
	return (
		<button
			type="button"
			class={className}
			data-test={test}
			title={title}
			aria-busy={busy}
			disabled={busy}
			onClick={save}
		>
			<Icon name="download" />
			{label}
		</button>
	);
}
