# Pinned mart snapshot

Verbatim copy of `/tmp/atm-mart/out/bundle.json` and `/tmp/atm-mart/README.md` from the coordinating atm session (t3-de2004b5-1d), backed up 2026-11-05 at 16:58 (file mtime) before `/tmp` could be cleaned. Do not edit.

- sha256 of `bundle.json` (computed with `shasum -a 256`): `b30adc2883efec15444dc44d082db5a23a0db11b22eb6e09fc0754c09f6c81a4`
- reconcile: 1308/1308 cells; all eight presets `hashes.ok`
- built from atm `b8dab4aec3b3e86905ecd9657aa94835ff3552ac` (`/Users/jmac/.t3/worktrees/atm/scenario-parity`, the build script's default, clean at backup)
- the live `/tmp` file was rebuilt later (sha256 `70fb44d5…`) with equal content per preset and different serialization; this pin does not follow it
- spot check against `../mockup.html` (`../smoke.mjs`): monthly-members June gross 62300, net 59204, paying 23; annual-prepay January gross 573500

The UI package imports it with `scripts/import-mart.ts` (protocol v4 §5.2), which refuses any other hash.
