# S8a: view snapshot hash changes

Input for the ledger-ui orchestrator, who regenerates `plans/ledger-ui/design/mart/views/` (`snapshot-mart.ts`) and any golden that hashes it. S8a does not touch them.

What changes, and why: `MonthView.money` is removed from `views/months/YYYY-MM.json` (it moved to `views/finance/months/YYYY-MM.json`), so every month object that had `money` changes bytes; three object kinds are added to every manifest (`views/finance/months/`, `views/finance/members/`, `views/kpi/contributions/`), so every `views/manifest.json` changes. Member objects and the member index are byte-for-byte unchanged (0 changed below). Presets with no money in any month (`free-only`, `non-usd`) keep their month objects.

Computed by `buildViews` + `writeViews` over `generateScenario(resolveScenario({ profile }))` at the preset's last event time (the snapshot's own `asOf`). Old hashes are the sha256 of the committed `manifest.json` files; "month objects changed" counts manifest entries whose hash differs from the committed manifest (all are month objects; the member count shows none moved).

| Preset | old manifest sha256 | new manifest sha256 | month objects changed | objects added |
|---|---|---|---|---|
| `free-only` | `926938aa7e4da3ab1d88badd7be76993c5a0dec8535315c74e836418809867ff` | `673aa4f0f8a2259c83824e2f26e3d7e68cfc821d54d0785c33f046ac3745eb24` | 0 (members changed: 0) | 12 |
| `monthly-members` | `dea1976e7cb1adf469aafc815e48e6bb5759307e0bd3b8595ce0f1397d7a7e5e` | `c47f01d6c9684e4b474e1736f957f8c80c513e7ed6b8c476f1dd694b4ec31b73` | 12 (members changed: 0) | 48 |
| `annual-prepay` | `85362602c444cc07f17bd5a3c708328c9c95ca80a9bde5a35aa2d36e4fff2e44` | `d9fe4d97543fd9ec9f071af8e194bddd658a25c5defbfb90a71ce1e78d21712e` | 2 (members changed: 0) | 52 |
| `heavy-refunds` | `7749e459fb6b181601851e522dddfe5fa764821baed03acaabafc0d90009bb99` | `1fea18937f0a9848b800fda4a19958038d342eaf1b48f1574fbb07e951dcd017` | 12 (members changed: 0) | 48 |
| `disputes` | `5d2420bcf6076442ad240b23c7c4982836748bbc30b6b729c7c638708a192908` | `2da42a76d9549d79e2fe2065c7ebd37752c975206365b6be3774b17326a4e3fe` | 12 (members changed: 0) | 48 |
| `non-usd` | `58a58a5a4365820aa412fa7425543f8c38d0c357ea50a6d48005c2ab48151f45` | `40781ba6431f5d9a4c5d38abb885096b10c7412650c5323ed2bd4aa58375358c` | 0 (members changed: 0) | 24 |
| `growth-12mo` | `dc6521d961a9de1b3da19175dcb44549a15dcbf5f6592d3997dd17b6056ba18b` | `4290a31a2cacb1853d4be53d818e3172b0f8ec6adbc4015131d036a9554ac26e` | 12 (members changed: 0) | 85 |
| `churn-spike` | `3226e18e84aca4387c6eb55502365b72ff9b5ff9082596e372f68fae9bca4024` | `71e8abaff33d9c2e6dd79952a957ad9a6715d2d11dcdcd882a8d79d17a97ecd2` | 6 (members changed: 0) | 52 |
| `one-payer-tier` | `2a22a84ae2743ff78bcdd66a23a2991851bcd356cb3d0310b8c27057d16de545` | `6d9f03c13cb56969120e6d2caca196a0965095bc062ab7f6b359d3f8db65236e` | 6 (members changed: 0) | 32 |
| `tiny-school` | `17c4d4b683dbd4a263f1e18a11b542365b7b44763922d3dd633e608d33037ea3` | `8e08fde565e263caaf46f79467c83b07ff414ec00a63c4a3f282a26999729846` | 6 (members changed: 0) | 16 |
| `single-refund-month` | `d5c313b8e5ca1cb5e2bd64d24f33e8875c3f930ee7b1dbc0ca9ac129072f1422` | `51eca3c6e9aec3be07d220366cfad07c2e63e510f1b720b71b588d307f4ce8b2` | 6 (members changed: 0) | 36 |
| `yearly-solo` | `1f9d73f4a5b1b3911991a21b3bb513a3a89b463db73a478a264e97189a7e4948` | `02048e59c2b5b8972298fb7bb3c4df60adebc24a85447bc53b0166678d478b52` | 12 (members changed: 0) | 34 |
| `fee-oracle` | `e132ed1a6d73eebf8271f04d83fbc8b59c6372aaf3c6c242b78ad510e97b982b` | `154c84214a6d1a46d518263f14041b05ea4066b582245aba6e8c1f6834edd18c` | 6 (members changed: 0) | 24 |
| `seminar-quantities` | `7dd251cf9168487abbfd6476bb3b8ec23cb88e612312a1a6e82532b212f3c22e` | `ea0f7f6f580bc1149bb5f7f244fd5e8c6a126f8b97879d12b1e6511dd7f3cfc4` | 6 (members changed: 0) | 24 |
| `child-only` | `daf640f265f3acb82287d86dd1b1efeeb392480b1340b81368bc44e2c1a84fc3` | `2d2730674446f06772448ed9ea4290cb311c4390d57d04dd259230f4d92e500d` | 6 (members changed: 0) | 12 |
