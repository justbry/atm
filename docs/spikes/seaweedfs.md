# Spike: SeaweedFS as local S3 server for the contract test suite

Date: 2026-11-04. Run in a throwaway sandbox (`<spike>` below); the test script `contract.ts` becomes the atm contract suite in slice 6. Before CI depends on SeaweedFS, replace the PyPI repackage with the official release pinned by version and checksum.

**Verdict:** usable. 21 of 22 checks pass on both bun 1.4.4 and node v22.23.4. The single difference from AWS is listed under Surprises (IfMatch on a missing key).

## Version

```
$ weed version
version 8000GB 4.48 pypi linux amd64
```

SeaweedFS 4.48, from the PyPI wheel `seaweedfs_bin-4.48-py3-none-manylinux_2_28_x86_64.musllinux_1_2_x86_64.whl` (uploaded 2026-10-02). It is a static Go binary, about 147 MB including the venv. "8000GB" means the large-disk build variant.
SDK: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1162.0.

## Install

1. GitHub release asset: **refused**. Through the sandbox proxy, `https://github.com/seaweedfs/seaweedfs/releases/latest` returns HTTP 403, and `gh release view` returns 403 ("GitHub access to this repository is not enabled for this session"). The empty `dl-github/` directory is left from that attempt.
2. PyPI via uv: **worked**.

```bash
mkdir -p <spike>/dl-pypi && cd <spike>/dl-pypi
uv venv .venv
uv pip install --python .venv/bin/python seaweedfs-bin==4.48
# binary: <spike>/dl-pypi/.venv/bin/weed
```

Note that the wheel is repackaged by a third party (github.com/Bing-su/pip-binary-factory). It is not an official SeaweedFS artifact.

## Run (simplest single-binary invocation)

`weed mini` starts master, volume, filer, S3, WebDAV, Iceberg, Lance and the admin UI in one process, without Docker. S3 listens on **:8333**. Two credential options both work.

**Option A: env vars (simplest)**
```bash
cd <spike>
AWS_ACCESS_KEY_ID=spikeaccess AWS_SECRET_ACCESS_KEY=spikesecret123 \
  dl-pypi/.venv/bin/weed mini -dir=$PWD/data-mini \
  -ip=127.0.0.1 -ip.bind=127.0.0.1 -master.telemetry=false
```
The env keys become an admin identity. A wrong secret returns `SignatureDoesNotMatch` with HTTP 403, and an unknown key returns `InvalidAccessKeyId` with HTTP 403. Anonymous `GET /` returns 403 AccessDenied.

**Option B: static config file**, `<spike>/s3.json`:
```json
{
  "identities": [
    {
      "name": "contract",
      "credentials": [ { "accessKey": "cfgaccess", "secretKey": "cfgsecret456" } ],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
```
```bash
dl-pypi/.venv/bin/weed mini -dir=$PWD/data-cfg -ip=127.0.0.1 -ip.bind=127.0.0.1 \
  -master.telemetry=false -s3.config=$PWD/s3.json
```
With the config file, only the keys in the file work (the env keys are rejected with InvalidAccessKeyId). The suite gives the same 21/22 result with either option.

Other ports that mini uses (the defaults): master 9333, volume 9340, filer 8888, WebDAV 7333, Iceberg 8181, Lance 9101, admin UI 23646, plus gRPC ports. These matter if you run more than one instance. `-bucket=name1,name2` pre-creates buckets. It starts in under 1 s. Stop it with SIGTERM; the filer can take 1 to 12 s to shut down.

Flags worth keeping: `-ip=127.0.0.1` (the default advertises a non-loopback IP), and `-master.telemetry=false` (telemetry is on by default and posts to telemetry.seaweedfs.com).

## Running the tests

```bash
cd <spike>
bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner   # already done; bun.lock present
bun contract.ts
node contract.ts            # Node 22.18+ strips TS types natively
# override: S3_ENDPOINT=http://127.0.0.1:8333 S3_ACCESS_KEY=... S3_SECRET_KEY=...
```
Each run creates two fresh buckets, `contract-<uuid8>` and `contract2-<uuid8>`. The client uses `region:"auto"`, `forcePathStyle:true`, and `requestChecksumCalculation`/`responseChecksumValidation` set to `"WHEN_REQUIRED"`. Case i uses a second client with SDK defaults.

## Results (identical on bun 1.4.4 and node v22.23.4)

| case | expected | actual | result |
|---|---|---|---|
| a1 PutObject IfNoneMatch `*`, new key | 200 | 200 | PASS |
| a2 PutObject IfNoneMatch `*`, existing key | 412 | `PreconditionFailed`, `$metadata.httpStatusCode` 412 | PASS |
| a3 body unchanged after refused create | "first" | "first" | PASS |
| b Put `Metadata{sha256}` then HeadObject | ETag + metadata.sha256 | ETag (quoted MD5, same as the PUT ETag), sha256 matches | PASS |
| c1 PutObject IfMatch current ETag | 200 | 200 | PASS |
| c2 PutObject IfMatch stale ETag | 412 | `PreconditionFailed` 412 | PASS |
| c3 (extra) PutObject IfMatch on a missing key | AWS: 404 NoSuchKey | `PreconditionFailed` 412 | **FAIL (differs from AWS)** |
| d 20 parallel IfMatch PUTs with the same ETag, x10 rounds | exactly 1 win and 19 x 412 per round | 1 win and 19 x 412 in all 10 rounds (190 x `PreconditionFailed` 412); no round had more than 1 winner | PASS |
| e1 DeleteObject IfMatch stale ETag | 412, object survives | `PreconditionFailed` 412, object survives (header is honored, not ignored) | PASS |
| e2 DeleteObject IfMatch current ETag | 204, object gone | 204; HeadObject then gives `NotFound` 404 | PASS |
| f1 ListObjectsV2 right after PUT | key visible | visible (read-after-write consistent) | PASS |
| f2 ListV2 Prefix + Delimiter `/` + MaxKeys 2, paginated (7 keys) | keys a,b,c and prefixes d1/,d2/,d3/ | 3 pages of [2,2,2] entries; keys a,b,c; CommonPrefixes d1/,d2/,d3/; MaxKeys counts keys plus prefixes, as AWS does | PASS |
| f3 ListV2 Prefix only, MaxKeys 2 | all 7, no duplicates, sorted | 4 pages, 7 keys, lexicographic | PASS |
| f4 ListV2 Prefix `d3/` + Delimiter | CommonPrefixes [d3/deep/] | [d3/deep/], 0 Contents | PASS |
| g GetObject Range bytes=2-5 | 206, "2345" | 206, "2345", `Content-Range: bytes 2-5/10` | PASS |
| h1 Presigned GET (expiresIn 2 s), immediately | 200 | 200, correct body | PASS |
| h2 Presigned GET after ~4 s | 403 | 403 `AccessDenied` | PASS |
| i1 SDK-default checksums: create-only PUT | 200 | 200, returns `ChecksumCRC32` | PASS |
| i2 SDK-default checksums: second create | 412 | `PreconditionFailed` 412 | PASS |
| i3 SDK-default checksums: GetObject with response validation | 200 | 200, body ok | PASS |
| i4 SDK-default checksums: streamed Node `Readable` body (aws-chunked plus trailing checksum) | 200, round-trips | 200, round-trips | PASS |
| j CopyObject across buckets, MetadataDirective REPLACE | 200, new metadata only, new Content-Type | 200; metadata `{sha256:"new"}` (old `keep` dropped); new Content-Type; body intact | PASS |

## Surprises / differences from AWS S3

1. **IfMatch on a missing key returns 412, not 404.** AWS returns `404 NoSuchKey` for a conditional PUT with If-Match when no object exists. SeaweedFS returns `412 PreconditionFailed`. Either accept both codes in the contract or assert only "refused".
2. **Default checksums are fine.** SeaweedFS 4.48 accepts the SDK's default CRC32 (header and aws-chunked trailer forms) and returns `ChecksumCRC32`. `WHEN_REQUIRED` is not needed for SeaweedFS, but keeping it is harmless and helps with other backends.
3. **Test-harness gotcha, not a SeaweedFS issue.** With a web `ReadableStream` body and SDK-default checksums, the SDK fails client-side under bun with `Unable to calculate hash for flowing readable stream`. Use a Node `Readable` or a Buffer. Case i4 now uses `Readable.from`.
4. Conditional writes are atomic under contention: 200 racing writers produced zero double-wins. Conditional DELETE (If-Match) is implemented. AWS added that only in 2024, and some S3 clones ignore it.
5. `weed mini` turns on many extras by default (WebDAV, Iceberg, Lance, admin UI with no password, embedded IAM). Telemetry is on unless `-master.telemetry=false` is passed.
6. GitHub release downloads are blocked in this sandbox, so the binary comes from a third-party PyPI repackage.
7. Process management: `nohup ... & echo $!` records the wrapping shell's PID, not weed's. Use `setsid` or `pgrep -f "weed mini -dir=<dir>"` to find and stop the real process.

## Files

- `<spike>/contract.ts`: the test suite (prints the table above)
- `<spike>/s3.json`: static identity config (option B)
- `<spike>/dl-pypi/.venv/bin/weed`: the binary
- `<spike>/mini.log`, `<spike>/mini-cfg.log`: server logs
- `<spike>/data-mini`, `<spike>/data-cfg`: throwaway data directories (safe to delete)
