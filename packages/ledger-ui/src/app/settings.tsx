import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Reader } from "../data/reader.ts";
import {
	type AccountingBasis,
	type ApiKey,
	type ApiKeyKind,
	basisExample,
	type CreatedKey,
	maxLiveKeysPerKind,
	pinMinimumLength,
	restrictedKeyMessage,
	type SchoolSettings as SettingsData,
	stripePermissions,
	zeffyKeyMinimumLength,
} from "../data/settings.ts";
import type { School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { Icon, type IconName } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { formatMoney } from "./money.ts";
import { monthAndDay } from "./period.ts";
import { Popover } from "./popover.tsx";
import { BooksSection } from "./settings-books.tsx";
import {
	Field,
	type Section,
	SettingsDialog,
	saveFailed,
	useDialogChain,
} from "./settings-shared.tsx";
import { keepLoading } from "./use-loaded.ts";
import { exitPreviewTitle, type Viewing } from "./viewing.ts";

/** The school's money without decimals, as the mockup's `kusd0` writes it; minor units in. */
const moneyOf =
	(currency: string) =>
	(minorUnits: number): string =>
		formatMoney(minorUnits, currency, true);

/** The drawer's note on All schools (mockup `settings()`). */
export function AllSchoolsNote(): JSX.Element {
	return (
		<div class="prev settings-all-note" data-test="settings-all-note">
			<Icon name="info" /> Accounting, keys and connections are set per school.
			Open a school to change them.
		</div>
	);
}

/** One row of Keys and Connections (mockup `crow`). */
function Row({
	icon,
	name,
	badges,
	detail,
	actions,
	hooks,
	detailHook,
}: {
	icon: IconName;
	name: ComponentChildren;
	badges: ComponentChildren;
	detail: ComponentChildren;
	actions: ComponentChildren;
	hooks: Record<string, string>;
	detailHook: string;
}): JSX.Element {
	return (
		<div class="crow" {...hooks}>
			<span class="cic">
				<Icon name={icon} />
			</span>
			<div class="cm">
				{name} {badges}
				<div class="mut" data-test={detailHook}>
					{detail}
				</div>
			</div>
			<div class="ca">{actions}</div>
		</div>
	);
}

function BasisSection({
	school,
	writer,
	settings,
	update,
	writeOff,
	money,
	onToast,
}: Section): JSX.Element {
	const [selected, setSelected] = useState<AccountingBasis>(settings.basis);
	const [from, setFrom] = useState(settings.basisFrom);
	const [busy, setBusy] = useState(false);
	const cash = selected === "cash";
	const save = async (): Promise<void> => {
		setBusy(true);
		try {
			await writer.saveAccountingBasis({
				school: school.id,
				basis: selected,
				from,
			});
			update((current) => ({ ...current, basis: selected, basisFrom: from }));
			onToast(
				`Accounting basis saved: ${selected} from ${monthAndDay(from)}. Logged as a policy change.`,
			);
		} catch {
			onToast(saveFailed);
		}
		setBusy(false);
	};
	return (
		<>
			<h5 data-test="settings-section" data-section="basis">
				<Icon name="scale" /> Accounting basis
			</h5>
			{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
			<div class="seg" role="group" aria-label="Accounting basis">
				{(["cash", "deferred"] as const).map((basis) => (
					<button
						key={basis}
						type="button"
						class={basis === selected ? "on" : undefined}
						aria-pressed={basis === selected}
						data-test="basis-option"
						data-basis={basis}
						{...writeOff}
						onClick={() => setSelected(basis)}
					>
						{basis === "cash" ? "Cash" : "Deferred"}
					</button>
				))}
			</div>
			<p class="mut basis-note" data-test="basis-note">
				{cash
					? "Income counts when the money arrives."
					: "Income counts as the service is given. Gifts are a liability until redeemed."}{" "}
				A {money(basisExample.yearly)} yearly plan counts{" "}
				<b>
					{cash
						? `${money(basisExample.yearly)} at once`
						: `${money(basisExample.monthly)} a month`}
				</b>
				.
			</p>
			<div class="row2">
				<label class="mut" for="bfrom">
					From
				</label>
				<input
					id="bfrom"
					type="date"
					data-test="basis-from"
					value={from}
					{...writeOff}
					onInput={(event) => setFrom(event.currentTarget.value)}
				/>
				<button
					type="button"
					class="btn p"
					data-test="basis-save"
					{...writeOff}
					disabled={writeOff.disabled || busy}
					aria-busy={busy || undefined}
					onClick={save}
				>
					Save
				</button>
			</div>
		</>
	);
}

const copyFailedToast =
	"Could not copy: the browser blocked the clipboard. Select the text and copy it by hand.";
const keyNames: Record<ApiKeyKind, string> = {
	pk: "publishable key",
	sk: "secret key",
	rd: "ledger read credential",
};
const keyHints: Record<ApiKeyKind, string> = {
	pk: "For browsers, from your allowed origins. Reads public school data.",
	sk: "For servers only. A browser request with it is refused.",
	rd: "Read-only, limited to your school's folder.",
};
const keyBadges: Record<ApiKeyKind, string> = {
	pk: "Publishable",
	sk: "Secret",
	rd: "Ledger read",
};
const keyIcons: Record<ApiKeyKind, IconName> = {
	pk: "key",
	sk: "key",
	rd: "db",
};
const keyMenuLabels: Record<ApiKeyKind, string> = {
	pk: "Publishable key",
	sk: "Secret key",
	rd: "Ledger read credential",
};
const keyKinds: ApiKeyKind[] = ["pk", "sk", "rd"];

function KeyCreateDialog({
	kind,
	onCreate,
	onCancel,
}: {
	kind: ApiKeyKind;
	onCreate: (label: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [label, setLabel] = useState("");
	return (
		<SettingsDialog
			title={`Create ${keyNames[kind]}`}
			icon="key"
			confirm={{ label: "Create", onConfirm: () => onCreate(label) }}
			onCancel={onCancel}
		>
			<p class="mut">{keyHints[kind]}</p>
			<Field
				label="Label"
				field="label"
				value={label}
				onInput={setLabel}
				placeholder="For example: Website"
				secret={false}
			/>
		</SettingsDialog>
	);
}

function KeyCreatedDialog({
	created,
	onDone,
	onToast,
}: {
	created: CreatedKey;
	onDone: () => void;
	onToast: (text: string) => void;
}): JSX.Element {
	const copyButton = (
		label: string,
		text: string,
		toast: string,
	): JSX.Element => (
		<div class="row2">
			<button
				type="button"
				class="btn p"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(text);
						onToast(toast);
					} catch {
						onToast(copyFailedToast);
					}
				}}
			>
				<Icon name="copy" />
				{label}
			</button>
		</div>
	);
	if (created.kind === "rd") {
		const { endpoint, bucket, prefix, keyId, secret } = created.credential;
		const credentialText = `endpoint  ${endpoint}\nbucket    ${bucket}\nprefix    ${prefix}\nkey id    ${keyId}\nsecret    ${secret}`;
		return (
			<SettingsDialog
				title="Credential created"
				confirm={{ label: "I stored it", onConfirm: onDone }}
				cancelable={false}
				onCancel={onDone}
			>
				<div class="mut">The secret is shown once.</div>
				<div class="pre">{credentialText}</div>
				{copyButton("Copy all", credentialText, "Credential copied.")}
			</SettingsDialog>
		);
	}
	return (
		<SettingsDialog
			title="Key created"
			confirm={{ label: "I stored it", onConfirm: onDone }}
			cancelable={false}
			onCancel={onDone}
		>
			<div class="mut">Shown once. Copy it now.</div>
			<div class="codebig mono">{created.secret}</div>
			{copyButton("Copy key", created.secret, "Key copied.")}
			<p class="mut">
				Only the SHA-256 and the first 15 characters are stored.
			</p>
		</SettingsDialog>
	);
}

function KeysSection({
	school,
	writer,
	settings,
	update,
	writeOff,
	onToast,
	onModal,
}: Section): JSX.Element {
	const dialogs = useDialogChain(onModal);
	const closeModal = dialogs.close;
	const startCreate = (kind: ApiKeyKind): void => {
		const live = settings.keys.filter((key) => key.kind === kind).length;
		if (kind !== "rd" && live >= maxLiveKeysPerKind) {
			onToast("Two live keys of this kind already. Revoke one first.");
			return;
		}
		const afterCreate = dialogs.show(
			<KeyCreateDialog
				kind={kind}
				onCancel={dialogs.close}
				onCreate={async (label) => {
					const created = await writer.createKey({
						school: school.id,
						kind,
						label: label || "No label",
					});
					update((current) => ({
						...current,
						keys: [...current.keys, created.key],
					}));
					afterCreate(
						<KeyCreatedDialog
							created={created}
							onDone={dialogs.close}
							onToast={onToast}
						/>,
					);
				}}
			/>,
		);
	};
	const startRevoke = (key: ApiKey): void =>
		onModal(
			<SettingsDialog
				title={`Revoke this ${key.kind === "rd" ? "credential" : "key"}?`}
				confirm={{
					label: "Revoke",
					icon: "trash",
					danger: true,
					onConfirm: async () => {
						await writer.revokeKey({ school: school.id, keyId: key.id });
						update((current) => ({
							...current,
							keys: current.keys.filter(({ id }) => id !== key.id),
						}));
						closeModal();
						onToast("Revoked.");
					},
				}}
				onCancel={closeModal}
			>
				<p class="mut">
					<span class="mono">{key.prefix}…</span> ({key.label}). Anything using
					it stops working at once. This can't be undone.
				</p>
			</SettingsDialog>,
		);
	return (
		<>
			<h5 data-test="settings-section" data-section="keys">
				<Icon name="key" /> Keys and access{" "}
				<span class="mut section-note">we give you</span>
			</h5>
			{settings.keys.map((key) => (
				<Row
					key={key.id}
					icon={keyIcons[key.kind]}
					hooks={{ "data-test": "key-row", "data-key": key.id }}
					name={<b data-test="key-label">{key.label}</b>}
					badges={<span class="badge">{keyBadges[key.kind]}</span>}
					detailHook="key-detail"
					detail={
						<>
							<span class="mono">{key.prefix}…</span> · used {key.used}
						</>
					}
					actions={
						<button
							type="button"
							class="btn ico s d"
							data-test="key-revoke"
							data-key={key.id}
							aria-label={`Revoke ${key.label}`}
							{...writeOff}
							title={writeOff.title ?? "Revoke"}
							onClick={() => startRevoke(key)}
						>
							<Icon name="trash" />
						</button>
					}
				/>
			))}
			{settings.keys.length === 0 && (
				<div class="mut" data-test="keys-empty">
					No keys yet.
				</div>
			)}
			<Popover
				wrapperClass="key-create"
				trigger={{
					class: "btn",
					"data-test": "key-create",
					"aria-haspopup": "menu",
					...writeOff,
				}}
				panelClass="menu"
				label={
					<>
						<Icon name="plus" />
						Create
						<Icon name="chevronDown" />
					</>
				}
			>
				{(close) =>
					keyKinds.map((kind) => (
						<button
							key={kind}
							type="button"
							role="menuitem"
							data-test="key-create-option"
							data-kind={kind}
							onClick={() => {
								close();
								startCreate(kind);
							}}
						>
							<Icon name={keyIcons[kind]} />
							{keyMenuLabels[kind]}
						</button>
					))
				}
			</Popover>
		</>
	);
}

function PermissionsDialog({
	settings,
	onClose,
	onToast,
}: {
	settings: SettingsData;
	onClose: () => void;
	onToast: (text: string) => void;
}): JSX.Element | null {
	const { stripe } = settings;
	if (!stripe.connected) return null;
	const missing = stripe.missing;
	const mark = (name: string, ok: boolean): JSX.Element => (
		<div
			key={name}
			class={ok ? "ok" : "no"}
			data-test="permission-item"
			data-permission={name}
			data-ok={String(ok)}
		>
			<Icon name={ok ? "check" : "xCircle"} />
			<span class="permission-name">{name}</span>
		</div>
	);
	return (
		<SettingsDialog
			title="Stripe permissions"
			icon="card"
			confirm={{ label: "Done", onConfirm: onClose }}
			cancelable={false}
			onCancel={onClose}
			extra={
				<button
					type="button"
					class="btn"
					onClick={() => onToast("Opening Stripe…")}
				>
					<Icon name="ext" />
					Open Stripe
				</button>
			}
		>
			<div class="mut">
				{stripe.account} · key ending {stripe.last4}
			</div>
			<h5>Needed to sell plans</h5>
			<div class="permg">
				{[...stripePermissions.write, ...stripePermissions.read].map((name) =>
					mark(name, true),
				)}
			</div>
			<h5>Needed for Send invoice and Refund</h5>
			<div class="permg">
				{stripePermissions.money.map((name) =>
					mark(name, !missing.includes(name)),
				)}
			</div>
			{missing.length > 0 ? (
				<div class="prev">
					<b class="err">{missing.length} missing.</b> {missing.join(" and ")}{" "}
					stay disabled until you add {missing.length === 1 ? "it" : "them"} to
					the key in Stripe (Developers, API keys).
				</div>
			) : (
				<div class="prev ok">
					<Icon name="check" /> All permissions are present.
				</div>
			)}
		</SettingsDialog>
	);
}

function StripeKeyDialog({
	replacing,
	onSave,
	onCancel,
}: {
	replacing: boolean;
	onSave: (restrictedKey: string, pin: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [key, setKey] = useState("");
	const [pin, setPin] = useState("");
	const { text, ok } = restrictedKeyMessage(key);
	const mistake = key.trim() !== "" && !ok && !text.startsWith("Keep typing");
	return (
		<SettingsDialog
			title={`${replacing ? "Replace" : "Connect"} Stripe`}
			icon="card"
			confirm={{
				label: "Save key",
				icon: "check",
				disabled: !(ok && pin.length >= pinMinimumLength),
				onConfirm: () => onSave(key.trim(), pin),
			}}
			onCancel={onCancel}
		>
			<p class="mut">
				Paste a <b>restricted</b> key from your own Stripe account. It is stored
				encrypted and only its last four characters are shown afterwards.
			</p>
			<Field
				label="Restricted key"
				field="key"
				value={key}
				onInput={setKey}
				placeholder="rk_live_…"
			/>
			<Field
				label="Your family PIN"
				field="pin"
				value={pin}
				onInput={setPin}
				numeric
			/>
			<div class="prev" data-test="dialog-message">
				{ok && <Icon name="check" />}
				{mistake ? <b class="err">{text}</b> : text}
			</div>
		</SettingsDialog>
	);
}

function ZeffyKeyDialog({
	replacing,
	onSave,
	onCancel,
}: {
	replacing: boolean;
	onSave: (apiKey: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [apiKey, setApiKey] = useState("");
	return (
		<SettingsDialog
			title={`${replacing ? "Replace" : "Connect"} Zeffy`}
			icon="heart"
			confirm={{
				label: "Save key",
				icon: "check",
				disabled: apiKey.trim().length < zeffyKeyMinimumLength,
				onConfirm: () => onSave(apiKey.trim()),
			}}
			onCancel={onCancel}
		>
			<p class="mut">
				Paste the API key a Zeffy admin created. It is stored encrypted, used
				only to read payments, and never shown again.
			</p>
			<Field
				label="Zeffy API key"
				field="apiKey"
				value={apiKey}
				onInput={setApiKey}
			/>
			<div class="prev">
				<Icon name="info" /> Zeffy doesn't document webhook signing, so every
				payment is verified by looking it up in Zeffy before it is recorded.
			</div>
		</SettingsDialog>
	);
}

function RemoveDialog({
	what,
	note,
	onRemove,
	onCancel,
}: {
	what: string;
	note: string;
	onRemove: (pin: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [pin, setPin] = useState("");
	return (
		<SettingsDialog
			title={`Remove ${what}?`}
			confirm={{
				label: "Remove",
				icon: "trash",
				danger: true,
				disabled: pin.length < pinMinimumLength,
				onConfirm: () => onRemove(pin),
			}}
			onCancel={onCancel}
		>
			<p class="mut">{note}</p>
			<Field
				label="Your family PIN"
				field="pin"
				value={pin}
				onInput={setPin}
				numeric
			/>
		</SettingsDialog>
	);
}

function ConnectionsSection({
	school,
	writer,
	settings,
	update,
	writeOff,
	onToast,
	onModal,
}: Section): JSX.Element {
	const { stripe, zeffy } = settings;
	const closeModal = (): void => onModal(null);
	const saveStripe = (): void =>
		onModal(
			<StripeKeyDialog
				replacing={stripe.connected}
				onCancel={closeModal}
				onSave={async (restrictedKey, pin) => {
					await writer.saveStripeKey({ school: school.id, restrictedKey, pin });
					update((current) => ({
						...current,
						stripe: {
							connected: true,
							account: school.name,
							mode: "live",
							last4: restrictedKey.slice(-4),
							missing: current.stripe.connected ? current.stripe.missing : [],
						},
					}));
					closeModal();
					onToast("Stripe key saved. Run Check to confirm permissions.");
				}}
			/>,
		);
	const removeStripe = (): void =>
		onModal(
			<RemoveDialog
				what="the Stripe key"
				note="Plans stop being sold and new payments can't be taken until you connect again."
				onCancel={closeModal}
				onRemove={async (pin) => {
					await writer.removeStripeKey({ school: school.id, pin });
					update((current) => ({ ...current, stripe: { connected: false } }));
					closeModal();
				}}
			/>,
		);
	const saveZeffy = (): void =>
		onModal(
			<ZeffyKeyDialog
				replacing={zeffy.connected}
				onCancel={closeModal}
				onSave={async (apiKey) => {
					await writer.saveZeffyKey({ school: school.id, apiKey });
					update((current) => ({
						...current,
						zeffy: { connected: true, last4: apiKey.slice(-4) },
					}));
					closeModal();
					onToast("Zeffy connected.");
				}}
			/>,
		);
	const removeZeffy = (): void =>
		onModal(
			<RemoveDialog
				what="the Zeffy key"
				note="Fundraising payments stop being recorded."
				onCancel={closeModal}
				onRemove={async (pin) => {
					await writer.removeZeffyKey({ school: school.id, pin });
					update((current) => ({ ...current, zeffy: { connected: false } }));
					closeModal();
				}}
			/>,
		);
	const removeButton = (
		hook: string,
		label: string,
		onClick: () => void,
	): JSX.Element => (
		<button
			type="button"
			class="btn s d"
			data-test={hook}
			aria-label={label}
			{...writeOff}
			onClick={onClick}
		>
			<Icon name="trash" />
		</button>
	);
	return (
		<>
			<h5 id="conn" data-test="settings-section" data-section="connections">
				<Icon name="plug" /> Connections{" "}
				<span class="mut section-note">you give us</span>
			</h5>
			<Row
				icon="card"
				hooks={{ "data-test": "connection-row", "data-connection": "stripe" }}
				name={<b>Stripe</b>}
				badges={
					stripe.connected ? (
						<>
							<span class="badge b-ok">
								<Icon name="check" />
								Connected
							</span>{" "}
							<span class="badge">{stripe.mode}</span>
							{stripe.missing.length > 0 && (
								<>
									{" "}
									<span class="badge b-warn">
										<Icon name="alert" />
										{stripe.missing.length} permission
										{stripe.missing.length === 1 ? "" : "s"} missing
									</span>
								</>
							)}
						</>
					) : (
						<span class="badge">Not connected</span>
					)
				}
				detailHook="connection-detail"
				detail={
					stripe.connected
						? `${stripe.account} · key ending ${stripe.last4}`
						: "Sell plans and take payments through your own Stripe account."
				}
				actions={
					stripe.connected ? (
						<>
							<button
								type="button"
								class="btn s"
								data-test="stripe-check"
								onClick={() =>
									onModal(
										<PermissionsDialog
											settings={settings}
											onClose={closeModal}
											onToast={onToast}
										/>,
									)
								}
							>
								<Icon name="check" />
								Check
							</button>
							<button
								type="button"
								class="btn s"
								data-test="stripe-connect"
								{...writeOff}
								onClick={saveStripe}
							>
								Replace
							</button>
							{removeButton(
								"stripe-remove",
								"Remove the Stripe key",
								removeStripe,
							)}
						</>
					) : (
						<button
							type="button"
							class="btn p s"
							data-test="stripe-connect"
							{...writeOff}
							onClick={saveStripe}
						>
							Connect
						</button>
					)
				}
			/>
			<Row
				icon="heart"
				hooks={{ "data-test": "connection-row", "data-connection": "zeffy" }}
				name={<b>Zeffy</b>}
				badges={
					zeffy.connected ? (
						<span class="badge b-ok">
							<Icon name="check" />
							Connected
						</span>
					) : (
						<span class="badge">Not connected</span>
					)
				}
				detailHook="connection-detail"
				detail={
					zeffy.connected
						? `Reads fundraising payments · key ending ${zeffy.last4}`
						: "Record donations from your Zeffy campaigns in your ledger."
				}
				actions={
					zeffy.connected ? (
						<>
							<button
								type="button"
								class="btn s"
								data-test="zeffy-connect"
								{...writeOff}
								onClick={saveZeffy}
							>
								Replace
							</button>
							{removeButton(
								"zeffy-remove",
								"Remove the Zeffy key",
								removeZeffy,
							)}
						</>
					) : (
						<button
							type="button"
							class="btn p s"
							data-test="zeffy-connect"
							{...writeOff}
							onClick={saveZeffy}
						>
							Connect
						</button>
					)
				}
			/>
			<Row
				icon="cloud"
				hooks={{ "data-test": "connection-row", "data-connection": "bucket" }}
				name={<b>Your own bucket (S3 or R2)</b>}
				badges={<span class="badge">Later</span>}
				detailHook="connection-detail"
				detail="Send a copy of your ledger to a bucket you own. Not available yet."
				actions={
					<button type="button" class="btn s" data-test="bucket-setup" disabled>
						Set up
					</button>
				}
			/>
		</>
	);
}

/** The drawer's school settings (mockup `settings()`): the school's heading, the owners-only line, Accounting basis,
 * School books (the disclosure table and its override editor, or a lock panel for a viewer below the admins), Keys
 * and access, Connections. Owners change them with the PIN where the mockup asks for it; an admin reads them; while
 * previewing, every write control is disabled. A write's dialog stays open until the Writer answers. */
export function SchoolSettings({
	reader,
	writer,
	school,
	viewing,
	onToast,
	onModal,
}: {
	reader: Reader;
	writer: Writer;
	school: School;
	viewing: Viewing;
	onToast: (text: string) => void;
	onModal: (modal: ComponentChildren) => void;
}): JSX.Element | null {
	const [settings, setSettings] = useState<SettingsData | null>(null);
	useEffect(() => {
		let current = true;
		reader.settings(school.id).then((loaded) => {
			if (current) setSettings(loaded);
		}, keepLoading);
		return () => {
			current = false;
		};
	}, [reader, school.id]);
	if (!settings) return null;
	const own = viewing.option.value === "owner";
	const section: Section = {
		school,
		writer,
		settings,
		update: (change) =>
			setSettings((current) => (current ? change(current) : current)),
		writeOff: {
			disabled: !own,
			title: viewing.preview ? exitPreviewTitle : undefined,
		},
		money: moneyOf(school.currency),
		onToast,
		onModal,
	};
	const booksLock = viewing.option.locks["settings-books"];
	return (
		<>
			<div class="sechead" data-test="settings-school">
				<Icon name="building" /> {school.name}{" "}
				<span class="mut section-note">school settings</span>
			</div>
			{!own && (
				<div class="lock" data-test="settings-readonly">
					<Icon name="lock" /> Owners only. You are an admin here: you can look,
					not change.
				</div>
			)}
			<BasisSection {...section} />
			{booksLock ? (
				<LockPanel lock={booksLock} surface="settings-books" />
			) : (
				<BooksSection {...section} viewing={viewing} />
			)}
			<KeysSection {...section} />
			<ConnectionsSection {...section} />
		</>
	);
}
