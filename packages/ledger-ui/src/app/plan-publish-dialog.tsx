import type { JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { Dialog } from "./dialog.tsx";
import { Icon } from "./icon.tsx";
import type { PlanChange } from "./plans-menu.ts";

const minimumPinLength = 4;
const maximumPinLength = 6;

type PlanPublishDialogProps = {
	schoolName: string;
	/** The live version, and the one publishing makes. */
	fromVersion: number;
	changes: PlanChange[];
	/** Active members of the live tiers the draft changes or removes. */
	affectedMembers: number;
	/** Only an owner publishes; an admin's draft waits for one. */
	owner: boolean;
	/** `publishMenu` is pending: the dialog stays until it resolves. */
	pending: boolean;
	onPublish: () => void;
	onCancel: () => void;
};

/** The review before publishing (mockup `reviewModal`): each change with what it does on Stripe, who is affected, and
 * for an owner the family PIN that enables Publish (the server checks it on the session). Escape, the backdrop and
 * Cancel close it unless a publish is pending. */
export function PlanPublishDialog({
	schoolName,
	fromVersion,
	changes,
	affectedMembers,
	owner,
	pending,
	onPublish,
	onCancel,
}: PlanPublishDialogProps): JSX.Element {
	const [pin, setPin] = useState("");
	const pinId = useId();
	const publishEnabled = owner && pin.length >= minimumPinLength && !pending;
	return (
		<Dialog
			title={
				<>
					<Icon name="upload" /> Review and publish
				</>
			}
			onClose={onCancel}
			busy={pending}
			hooks="publish"
		>
			<div class="mut" data-test="plan-publish-versions">
				{schoolName} · v{fromVersion} → v{fromVersion + 1}
			</div>
			{changes.map((change) => (
				<div
					key={`${change.kind}:${change.id}`}
					data-test="plan-publish-change"
					data-plan={change.id}
				>
					<h5 class="change-name">
						<Icon name={change.kind === "tiers" ? "layers" : "gift"} />{" "}
						{change.name}
					</h5>
					{change.lines.map((line) => (
						<div key={line.title}>
							{line.title}
							<div class="mut change-detail">
								<Icon name="plug" /> {line.detail}
							</div>
						</div>
					))}
				</div>
			))}
			<div class="prev" data-test="plan-publish-summary">
				{affectedMembers > 0 ? (
					<>
						New purchases get the new terms.{" "}
						<b>
							{affectedMembers} current member
							{affectedMembers === 1 ? "" : "s"}
						</b>{" "}
						keep the version they bought.
					</>
				) : (
					"No current members are affected."
				)}{" "}
				The change applies at once (it doesn't wait for the next local month).
			</div>
			{owner ? (
				<div class="fld">
					<label for={pinId}>Your family PIN</label>
					<input
						id={pinId}
						type="password"
						inputMode="numeric"
						maxLength={maximumPinLength}
						autoComplete="off"
						data-test="plan-publish-pin"
						value={pin}
						onInput={(event) => setPin(event.currentTarget.value)}
					/>
				</div>
			) : (
				<div class="lock" data-test="plan-publish-lock">
					<Icon name="lock" /> Owners publish. You are an admin here, so your
					draft waits for an owner.
				</div>
			)}
			<div class="mf">
				<button
					type="button"
					class="btn"
					data-test="plan-publish-cancel"
					data-autofocus
					disabled={pending}
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn p"
					data-test="plan-publish-go"
					title={owner ? undefined : "Owners publish"}
					disabled={!publishEnabled}
					onClick={onPublish}
				>
					<Icon name="upload" />
					{pending ? "Publishing…" : `Publish v${fromVersion + 1}`}
				</button>
			</div>
		</Dialog>
	);
}
