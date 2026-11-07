# Ledger admin UI loop: results (2026-11-06)

The owner's goal: build `plans/ledger-ui/design/mockup.html` (frozen at atm #125) out into `packages/ledger-ui`; done when the mockup and the web UI score 9/10 similarity and 9/10 feature parity. **Met.** Protocol: `protocol-v8.md` with `protocol-v9-addendum.md`.

## Final whole-app panel (round 2)

54 contact sheets (9 surfaces × 6 View-as audiences, each at 1100/728/390 px in light and dark, app beside mockup) plus nine full-size pairs.

| Reviewer | Similarity | Parity |
| --- | --- | --- |
| Claude Opus 5.5 | 9 | 9 |
| Claude Fable 5.1 | 9 | 9 |
| Grok 4.7 | 9 | 9 |

Round 1 of this panel was void: the contact sheets drew the nonce about 4 px tall and every reviewer misread it. Its findings were acted on in fix rounds 7 and 8. Round 2 added the full-size shots.

## Slice panels (similarity / parity, three reviewers each)

| Slice | Opus | Fable | Grok | Round |
| --- | --- | --- | --- | --- |
| S1b Dashboard on five audiences | 9 / 9 | 9 / 9 | 9 / 9 | 2 |
| S2 Bookings | 10 / 9 | 10 / 9 | 10 / 10 | 3 |
| S3 Plans (Edit, Preview, Code) | 9 / 9 | 9 / 9 | 9 / 9 | 2 |
| S4 Members | 9 / 9 | 9 / 9 | 9 / 9 | 2 |
| S5 Ledger, Reports, Promos | 9 / 9 | 9 / 9 | 9 / 9 | 2 |
| S6 Member portal | 9 / 9 | 9 / 9 | 9 / 9 | 2 |
| S7 Settings, View as, period | 9 / 9 | 9 / 9 | 9 / 9 | 2 |

S0 (#112) and S1 (#118) merged earlier. Parity gate R, which runs the mockup's own `smoke.mjs` against the UI: 288 pass, 39 N/A with written reasons every reviewer accepted, 0 fail.

## Pull requests

| PR | What | State |
| --- | --- | --- |
| #112 | S0 shell | merged |
| #118 | S1 Dashboard | merged |
| #126 | S2 alone | closed, superseded by #130 |
| #130 | S1b–S7 on one integrated line | merged |
| #131 | `bun run test` runs each test group in its own process; gate step "T all" | merged |
| #132 | Singular consequence wording; one copy of the booking-dialog sentences | merged |
| #133 | Final whole-app panel fixes, contact-sheet tool | merged |

## Deliberate differences from the mockup (orchestrator rulings)

- Remind host is disabled while previewing another audience: it sends a real write (`BookingsWriter.remindHost`) and every write is off in preview. The mockup's is a toast.
- Promos' Copy code is disabled for audiences below admin: copying a code the audience cannot read would leak it. The mockup leaves it enabled.
- The Refunds card reads "Not computed" where the audience's document carries no refund rate; the mockup prints "0.0% of gross" from its own data, a figure that audience's document does not hold.
- Reports' gift line shows one chevron (the mockup's doubled "› ›" is a glitch); "1 current member keeps" and "1 session is spent" fix the mockup's grammar.
- The Plans Code view's `# stripe:` lines name what is on Stripe, not `prod_`/`price_` ids: atm sends menu keys (parity line 367, N/A).
- Refunds are open to every admin (owner ruling D10, 2026-11-06), so an admin's Refund is enabled and the drawer carries no "Refunds need the owner role" note; the mockup keeps refunds the owner's. Send invoice and Adjust stay finance only.
- Vibes of Light's fixtures carry an unpublished Plans draft (Glow $65 → $70); many S3 golden entries exercise it, and reviewers counted it as data.

## Contract gaps for S8 (real adapters; S8 stays blocked)

Fields and calls the UI's contract carries that no route provides yet: `Booking.billing`, `Booking.seriesLabel`, `BookingsWriter.remindHost`, `MembersReader.auditMember`, `MemberDetail.stripeDashboardUrl`, `MembersWriter.resendReceipt`, `MemberBalance.rolledOver`, `PlanTierCount.monthlyMinor`, `IncomeStatement.previous.changes`, the publish PIN, Stripe price and product ids, a preset on the Reports audience query, and a month-aware `planSummary`. Blockers outside this repository: buzz-school's Cedar ledger area, the R2 emission, `catalog.published`, the wrangler config.

## Spend

Reviewer runs 78 of 150; builder runs 39.
