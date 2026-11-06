import type { DownloadFile } from "../data/ledger.ts";

const revokeAfterMilliseconds = 1000;

/** Saves a file in the browser through a temporary link, as the mockup's `kSave` does: the member drawer's and the
 * member portal's history, which their golden files keep out of the Writer. The books panes save through
 * `Writer.download` instead (S5's contract). */
export function saveFile({ name, type, text }: DownloadFile): void {
	const address = URL.createObjectURL(new Blob([text], { type }));
	const link = document.createElement("a");
	link.href = address;
	link.download = name;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(address), revokeAfterMilliseconds);
}
