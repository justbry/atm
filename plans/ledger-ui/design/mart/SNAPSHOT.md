# Mart snapshot

Written by `plans/ledger-ui/loop/tools/snapshot-mart.ts`; do not edit by hand. Source: the coordinating atm session's mart (`/tmp/atm-mart`), checked against atm at `2d2d5ce8a0052dd63cfe899330aa9c994b517332`.

- `bundle.json` sha256 `c0a90a305b02c1ad8f47c28838e8c54ad4c8537b99bcf13118c949a1c2022b21`, reconcile 1908/1908
- `kpis/<preset>.json.gz`: atm's own `scenario kpis` export, gzipped; its fixtureHash and kpisHash equal `packages/atm/tests/golden/scenarios`, and kpiHash(rows) recomputed with atm's `canonicalize` equals kpisHash
- `views/<preset>/`: atm's `writeViews` output (objects plus `views/manifest.json` with a sha256 per object) for the presets atm can replay

| Preset | fixtureHash | kpisHash | sha256 of kpis.json | Read slice |
|---|---|---|---|---|
| `annual-prepay` | `3b9db2b686b55a6cd9095e26e51168f430e7985f7db0c7f4870594a618db3f1a` | `50f5d3797a7baa45ef9f373f202310b70186724c8b633f5d2dad1b86b3069e58` | `6d863fab4294ec21d8f584aeffd67792b3207297eae806fff035f9ea43420eb5` | views at asOf 2027-12-31T03:52:00.000Z |
| `child-only` | `b32f015dc3f758fa6ecdca70812f9ebd5de3e213b7e701fa190952cfcbb259fd` | `7fdff1b66da7ac266d10e62eadf981e9a6b97977d6330e03a5f44709285e7a2e` | `3c102093ae2993cfed39fad113927c1fc9005091ee791b43b556ddd2315bd970` | views at asOf 2026-06-27T02:27:00.000Z |
| `churn-spike` | `a27fec7ebde43a1e1505295600b1c42b677678e183cc4a13be89e398e6c1c14e` | `8a2b8e43ae055baf91bfcb6052d62944758441d7fd5961771fe565759da22e64` | `b947fd3beeb4184c08d4b1714faf37277e2e58e4bfa6511e109ceee7cf343014` | views at asOf 2026-06-26T22:53:00.000Z |
| `disputes` | `16b044e6e990beec9bcc962e8c5045a579369feb80ed68639ad08ad37eeb6475` | `cdb68326ab7a6df5946077f2328ce129810616cc9e84ea178b249a694fcc165f` | `829e742bb0470307f58a7a5baadc1bbd4c7d8454f52519ba627e11055ec33c71` | views at asOf 2026-12-30T07:02:00.000Z |
| `fee-oracle` | `e221598dda32114044398bd13dea20b4b58aca973341cf7035ef0638d439cc65` | `2ec489546cad96a47359dc7dc95f3465aea08d9c40df4bf96331d4b2cd9090c7` | `f721528faa34ab03aa94c63589df49595785f84396bdf8515ffeebe9eacb3f48` | views at asOf 2026-06-26T16:53:00.000Z |
| `free-only` | `fc654e5924e365731c7b654e90d4d58aab9961df9ede4c5a7fafc34576ea439b` | `a72928fffd16c849d39ad0725c130cabbc5d9355895032e3c36f39843aa31833` | `3bafb43e6086aa1a3e915281f01efadba045a8350cbb01b40b687cfc141d2193` | views at asOf 2026-12-31T10:23:00.000Z |
| `growth-12mo` | `e35d37b28ef7e15e55cdbef3113efb2fffb23b5fe1f838953ca7417212cf7182` | `08de1600651af777bf85cc2875062be1f2f3f797b77e68eace80ffb44d3cf12f` | `da11c07338efb9e5a3cd2ddb9f83db766dc8db2744e8370e3ab36f8c40bd8791` | views at asOf 2026-12-31T06:19:00.000Z |
| `heavy-refunds` | `697f9671f01bb74cf0820ae8618f05524633fdd0eb902f3611028fd31e821cca` | `c772c490db8bfa7ca12e7a26f495f9dc33ec5f1f0c8fefde046fc7586b91b87e` | `39142de38cf43ecde0b9cdcb5c393d6af39197dc9f80eb67b7b7cd4313642db4` | views at asOf 2026-12-31T06:28:00.000Z |
| `monthly-members` | `53bf717957317f494cf662e1308274c7192b81e51d64a787fce69921a4ed7725` | `1d4ca82500b478f78978212fcfdd3173e6ebc81a8dd0c83aab821d1b4e8027fb` | `19447e4ebf4ad9c55342b36c0363e9fa1b856404d7535bb582d42a15d1a4fdb1` | views at asOf 2026-12-28T13:19:00.000Z |
| `non-usd` | `b68af6ea99b8cc2097e7a344b3d1035aecb1bbbff5b1ecb5ae24d9ea868eb46e` | `29675860dd793b94429794cf2127e032c35a6035d5d6a1ff6ddc5aea56c58db9` | `c7a603319e9121a784e7bdda75841839898cb1d462f7889347948dd90f7f6517` | views at asOf 2026-12-30T05:09:00.000Z |
| `one-payer-tier` | `5120d4becb3779654d36256ec454ecb55e8d33cbfcd35b6b755b133ad06064bd` | `58033f5c9703e1aa6daeb23f8b4f3197537e0d2939086c017b84865155ec7289` | `e09b5d9292dc7c059db0ca872446a658d9f7a3b24c2e91876e9eba29ac92fa11` | views at asOf 2026-06-28T18:28:00.000Z |
| `seminar-quantities` | `9398295f52d7804306184224cffaa13e40343311ff9c6f84d50870baa34cf162` | `f10a53bec6b6eb9f979b14206fdfd3cc45fdfbc1ddec7147eb9f5d8b03df9ff6` | `0e78c00782e2b75f329a8d7632b8826bcafc268cad73b30dc9ff18163e2f0b02` | views at asOf 2026-06-29T23:53:00.000Z |
| `single-refund-month` | `753c4fe7bebe1bf700b53edd1cdaf26bc40be81cb5757a8c577431729ac91366` | `f859f56580971235a41bdbd48b1f6d1d41bd02a54d8203c3f2aa7d63efbf1b4e` | `a2ab66e074ba08e58626aefb7dcc83922015627139035d63dbbd05d85afa8dc8` | views at asOf 2026-06-30T22:55:00.000Z |
| `tiny-school` | `7967e93b2bc47272cbfbd4a9461186197db70164edccf411c7061220c692566a` | `69f19d10622fa8a08ec73966372f0c3e8b2b85520655cb85e5997f8eea71e82b` | `5e20bd28513142127985087686b1dbeca3165a512c0e3c701f8488cfea72ae8c` | views at asOf 2026-06-30T23:07:00.000Z |
| `yearly-solo` | `a1e2744710fb9e2f2ce75766dc33b18220ac6e55c93562ba19e767985a1a47f8` | `ee1ee0fb014ef05ee684cec3508d5baacc383d944d7098d91a7b4097f94c2e17` | `8850df6162214f35e8dbf7a22494548593d43810fcab0dd3341a4ee48fee4e5c` | views at asOf 2026-12-27T16:19:00.000Z |

Presets atm's read slice cannot replay (atm's error, verbatim):

- none
