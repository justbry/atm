/**
 * The Store contract against R2Store talking to a local SeaweedFS (`weed mini`), the CI stand-in for R2. Needs the
 * `weed` binary: env ATM_WEED, or `weed` on PATH; otherwise the suite is skipped. See docs/spikes/seaweedfs.md.
 *
 * `weed mini` also starts WebDAV, Iceberg and an admin UI without a password, so everything binds to 127.0.0.1 and the
 * process is killed when the suite ends. The S3 port is a free one picked at start; the other ports are weed's
 * defaults, so a second weed on the machine makes the start fail loudly (the log is in the error).
 */

import { afterAll, beforeAll, describe } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { R2Store } from "../src/store/r2-store.js";
import { hasSeaweedfs, tmp, weedBinary } from "./helpers.js";
import { emptyStore, storeContract } from "./store-contract.js";

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

type Server = {
	process: ReturnType<typeof Bun.spawn>;
	directory: string;
	logPath: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	client: AwsClient;
};

let server: Server | null = null;

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});

const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const encodePath = (key: string) =>
	key.split("/").map(encodeURIComponent).join("/");

const startServer = async (): Promise<Server> => {
	if (weedBinary === null) throw new Error("no weed binary");
	const directory = await tmp("seaweedfs");
	const logPath = join(directory, "weed.log");
	const port = await freePort();
	const accessKeyId = `atm${randomBytes(6).toString("hex")}`;
	const secretAccessKey = randomBytes(18).toString("base64url");
	const child = Bun.spawn(
		[
			weedBinary,
			"mini",
			`-dir=${join(directory, "data")}`,
			"-ip=127.0.0.1",
			"-ip.bind=127.0.0.1",
			"-master.telemetry=false",
			`-s3.port=${port}`,
		],
		{
			env: {
				...process.env,
				AWS_ACCESS_KEY_ID: accessKeyId,
				AWS_SECRET_ACCESS_KEY: secretAccessKey,
			},
			stdout: Bun.file(logPath),
			stderr: Bun.file(logPath),
		},
	);
	const endpoint = `http://127.0.0.1:${port}`;
	const client = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: "s3",
		region: "auto",
	});
	const started: Server = {
		process: child,
		directory,
		logPath,
		endpoint,
		accessKeyId,
		secretAccessKey,
		client,
	};

	const deadline = Date.now() + START_TIMEOUT_MS;
	for (;;) {
		if (child.exitCode !== null) {
			throw new Error(
				`weed exited with ${child.exitCode} before S3 answered on ${endpoint}:\n${await Bun.file(logPath).text()}`,
			);
		}
		try {
			const response = await client.fetch(`${endpoint}/`);
			await response.arrayBuffer();
			if (response.status === 200) return started;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) {
			child.kill();
			throw new Error(
				`S3 did not answer on ${endpoint} in ${START_TIMEOUT_MS} ms:\n${await Bun.file(logPath).text()}`,
			);
		}
		await sleep(POLL_MS);
	}
};

const stopServer = async (running: Server): Promise<void> => {
	running.process.kill();
	const exited = await Promise.race([
		running.process.exited.then(() => true),
		sleep(STOP_TIMEOUT_MS).then(() => false),
	]);
	if (!exited) {
		running.process.kill("SIGKILL");
		await running.process.exited;
	}
	await rm(running.directory, { recursive: true, force: true });
};

const requireServer = (): Server => {
	if (server === null) throw new Error("SeaweedFS is not running");
	return server;
};

const expectStatus = async (
	response: Response,
	allowed: number[],
	what: string,
) => {
	const text = await response.text();
	if (!allowed.includes(response.status)) {
		throw new Error(`${what}: HTTP ${response.status} ${text}`);
	}
};

describe.skipIf(!hasSeaweedfs)("SeaweedFS (weed mini)", () => {
	beforeAll(async () => {
		server = await startServer();
	}, START_TIMEOUT_MS + 10_000);

	afterAll(async () => {
		if (server !== null) await stopServer(server);
		server = null;
	}, STOP_TIMEOUT_MS + 10_000);

	// One bucket per test: no prefix to agree on, and a test cannot see another's keys.
	storeContract("R2Store on SeaweedFS", async () => {
		const running = requireServer();
		const bucket = `atm-contract-${randomUUID().slice(0, 8)}`;
		await expectStatus(
			await running.client.fetch(`${running.endpoint}/${bucket}`, {
				method: "PUT",
			}),
			[200],
			`create bucket ${bucket}`,
		);
		const store = new R2Store({
			endpoint: running.endpoint,
			bucket,
			accessKeyId: running.accessKeyId,
			secretAccessKey: running.secretAccessKey,
			region: "auto",
		});
		return {
			store,
			cleanup: async () => {
				await emptyStore(store);
				await expectStatus(
					await running.client.fetch(`${running.endpoint}/${bucket}`, {
						method: "DELETE",
					}),
					[200, 204],
					`delete bucket ${bucket}`,
				);
			},
			supportsPresign: true,
			// SeaweedFS has no x-amz-meta-sha256 to give for an object put without it
			hashesMissingMetadata: false,
			writeWithoutMetadata: async (key, body) => {
				await expectStatus(
					await running.client.fetch(
						`${running.endpoint}/${bucket}/${encodePath(key)}`,
						{ method: "PUT", body },
					),
					[200],
					`raw put ${key}`,
				);
			},
		};
	});
});
