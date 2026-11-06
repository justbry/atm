import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
	type CsvColumn,
	csvMediaType,
	type DownloadFile,
	downloadedToast,
	toCsv,
} from "../data/ledger.ts";
import type { Writer } from "../data/writer.ts";
import { Icon } from "./icon.tsx";

const failedToast = "Could not save the file. Try again.";

/** What a CSV download needs: where the file goes and what it says. */
export type CsvFile<Row> = {
	name: string;
	columns: ReadonlyArray<CsvColumn<Row>>;
	rows: ReadonlyArray<Row>;
};

/** A CSV download (mockup `kSave`): the one way the app makes a file. The file is the contract's `toCsv` over the
 * columns and rows; `save` keeps it (the Writer's `download`, or the browser's `saveFile`); the toast counts the rows
 * once it is saved. */
export async function saveCsv<Row>(
	save: (file: DownloadFile) => Promise<void> | void,
	onToast: (text: string) => void,
	{ name, columns, rows }: CsvFile<Row>,
): Promise<void> {
	try {
		await save({ name, type: csvMediaType, text: toCsv(columns, rows) });
		onToast(downloadedToast(rows.length));
	} catch {
		onToast(failedToast);
	}
}

/** The books panes' download button: `saveCsv` through the Writer behind a button that is busy and disabled while
 * the Writer works. */
export function DownloadButton<Row>({
	writer,
	onToast,
	test,
	className,
	title,
	label,
	...file
}: CsvFile<Row> & {
	writer: Writer;
	onToast: (text: string) => void;
	test: string;
	className: string;
	title: string;
	label: string;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const save = async (): Promise<void> => {
		setBusy(true);
		await saveCsv((saved) => writer.download(saved), onToast, file);
		setBusy(false);
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
