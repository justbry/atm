/** A file the user saves: its name and its text. */
export type Download = (file: { name: string; text: string }) => void;

const csvType = "text/csv;charset=utf-8";
const revokeAfterMilliseconds = 1000;

/** Saves the text as a file through a temporary link, as the mockup's `kSave` does. */
export const saveFile: Download = ({ name, text }) => {
	const address = URL.createObjectURL(new Blob([text], { type: csvType }));
	const link = document.createElement("a");
	link.href = address;
	link.download = name;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(address), revokeAfterMilliseconds);
};
