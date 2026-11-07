# Trifold financial model

Status: draft, 2026-11-06. Every number in the worked example is an assumption to test, not a forecast. Code references are to `packages/atm` on `dev` (tfd 0.9.0) unless a path says otherwise. tfd is the engine and CLI (the `atm` command until the rename lands, so a command such as `tfd scenario kpis` runs as `atm scenario kpis` today).

This doc answers four questions:
1. Can tfd's scenario generator model Trifold's own business for 1–3 years today?
2. What blocks it, ranked?
3. How should expenses get into tfd?
4. What is the plan, step by step, and what would a 36-month Trifold run look like?

Companion docs: `business-plan.md` (section 8, the outlook this model should reproduce) and `pricing-strategy.md` (tiers, credits, overage).

## 1. Short answer

Not yet. The generator's engine is the right one: it runs every invoice, credit grant, spend, rollover, refund, dispute and payout through tfd's real billing rules, reads no clock, and checks its KPIs in three channels (the tfd fold, hledger, DuckDB). But it only knows the demo school's menu, it caps the population far below Trifold's, it has no growth curve, conversion or tier changes, it has no expenses beyond Stripe and disputes, and it has no MRR because a payment does not say whether it is monthly or yearly.

Three changes would make it usable: pass in a menu (section 4, phase 1), add growth and lifecycle knobs (phases 2 and 3), and add an expense event (phase 5). Until then, the outlook belongs in a notebook outside tfd (phase 0).

## 2. Mapping Trifold onto tfd

| Trifold | tfd concept | Where | Fits today? |
|---|---|---|---|
| Trifold itself | The school (`SCHOOL_ID`) | `src/scenario/school.ts:10` | Name only: hard-coded to `sch_before_university` |
| A customer business | A member ("family"), one in-memory subject each | `src/scenario/generate.ts:176-218` | Yes, as a concept |
| Starter, Pro, Witnessed | Menu tiers with monthly and yearly prices | `fixtures/billing/menu/before-university.json` | No: the generator only uses the demo menu (section 3, gap 1) |
| Free (cloud) | A tier at $0 | `schema/catalog/menu.v1.json` `amount` minimum 50 cents | No: a tier price must be at least 50 cents. Closest today: `freeShare`, a 100%-discounted invoice, drawn across all tiers |
| Witnessed + Bookkeeper (~$349) | Witnessed plus a monthly add-on, with the partner's part as a cost | Add-ons; `share.*` postings as the pattern for the partner's part (`src/ledger/postings.ts:255-277`) | Partly: the add-on fits, the passthrough does not exist |
| Credits (1 credit = $0.01, one month rollover) | A credit feature granted monthly with `rollover: { months: 1 }` | `menu.v1.json` `grant` and `rollover` (grant up to 100,000 units, rollover 1–24 months) | The menu can say it. The generator cannot spend it (gap 6) |
| Ledger events per month (the tier limit) | A second credit feature, or a cap outside tfd | — | Not as a limit: tfd has credit balances, not usage caps on a non-credit metric |
| Compliance packs ($15–30 per state program) | Recurring add-ons | `menu.v1.json` up to 6 add-ons | The menu fits. The generator buys at most one add-on per member, at sign-up, and only the first recurring add-on of an interval (`generate.ts:160-162`, `:198-203`) |
| Credit top-ups, event overage ($2 per 10,000) | One-time add-ons that grant credits | `menu.v1.json` add-on `every: "once"` | Menu yes, generator only at sign-up |
| Witness API (500 free, then $0.03–0.05 each) | Metered usage | `docs/usage-metering.md`: metered pricing is out of scope | No. Prepaid packs are the closest fit |
| Stripe fees on Trifold's revenue | `feePercent`, `feeFixedCents` → `expenses:billing:stripe-fees` | `src/scenario/params.ts:131-142`, `src/ledger/postings.ts:197-205` | Yes |
| Annual billing (two months free) | `yearlyShare`, `yearlyCount` | `params.ts:72-77`, `:155-160` | Yes for cash. No for MRR (gap 7) |
| 1–3 years | `months` 1–36 | `params.ts:43-48` | Yes: 36 months is exactly 3 years |

What works now, with no change: 36 months; monthly and yearly payments; refunds, partial refunds and disputes with their fees; Stripe fees on every payment; payouts; credit grants, rollover and expiry under the real engine; a constant churn rate; KPI export to `kpis.json` and `kpis.parquet` (`docs/scenarios.md`, "The export"); and three-channel parity on every KPI.

## 3. The gaps, ranked by how much they block a 1–3 year model

"Smallest fix" means the least change that gets a credible number, not the ideal design.

| # | Gap | Why it matters | Evidence | Smallest fix |
|---|---|---|---|---|
| 1 | **The generator is tied to the demo menu.** No menu can be passed in. Tier ids, the knob schema, credit spending and expiry all come from Before University | Every revenue number would be at Before University's prices ($12, $29, $9 a seat, $59), not Trifold's | `generate.ts:104` copies `BEFORE_UNIVERSITY_MENU`; `params.ts:40` builds `TIER_IDS` from it, and `tierMix` and `tierCounts` accept only those keys; usage spends only the `class` feature (`generate.ts:410-425`); expiry runs only the demo features (`generate.ts:538`, `FEATURES` from `school.ts:15`); the CLI has no `--menu` (`src/scenario/cli.ts:58-82`) | `generateScenario(scenario, { menu })`, a `menu` field in the scenario input (or `--menu <file>`), checked by `validateMenu`; derive `TIER_IDS` and the feature list from the menu; put the menu (or its hash) in the fixture hash (`src/scenario/fixture.ts:17-20`). Code, medium |
| 2 | **Population caps and run time.** `members` ≤ 200, `newMembersPerMonth` ≤ 50, so at most 1,950 members in 36 months. The plan has 1,000 paying and 8,000 free by year 3 | Free schools carry cost (hosting, AI credits) and are the conversion pool; they can't be left out of a P&L | `params.ts:55-66`; the count caps of `tierCounts`, `yearlyCount`, `refundCount` are also 200 (`:152`, `:158`, `:164`). Measured on this machine, 36 months, default knobs, `--channels atm`: 24 members 2.7 s, 100 members 31 s, 200 members 159 s. For 100 members, generation took 1.0 s and the tfd KPI fold 0.06 s; 28 s was the write-path round trip (`src/scenario/roundtrip.ts`: outbox, ship, read). Another run shared the machine, so treat these as indicative | Raise the caps (say 20,000 members, 2,000 a month) and add a planning mode that skips the round trip (the round trip proves the write path, which a business forecast doesn't need). Code, small. Fallback: a scale factor applied outside tfd (one simulated member = k schools), which makes small counts lumpy |
| 3 | **Constant growth.** One `newMembersPerMonth` for every month: no ramp, no S-curve, no school-year seasonality | Section 8 grows paying schools 50 → 300 → 1,000. A constant rate that ends at 1,000 in month 36 puts about 360 paying schools at month 12, seven times the plan (worked in section 5) | `params.ts:61-66`; `generate.ts:164-167` | A `joinsByMonth` series knob (up to 36 whole numbers, overriding `newMembersPerMonth`). A new knob kind, `series`, in `PARAMS`. Code, small |
| 4 | **No free-to-paid conversion and no upgrades or downgrades.** A member keeps its first tier for life | The plan's biggest unknown is "how many free schools convert to paid" (`business-plan.md` section 8). Net revenue retention above 110% (phase 3 of the plan) needs expansion | `FamilyPlan` is fixed before the run (`generate.ts:88-100`, `:320-519`). The engine already handles an upgrade (`subscription_update` with a proration line) and a downgrade at renewal (`src/billing/grants.ts:788-800`); `invoicePaid` already accepts `subscription_update` (`src/scenario/stripe-events.ts:68-72`). Only the generator never sends one | Knobs `freeTier` (members on it get zero invoices), `conversionRate` (monthly chance a free member moves to a paid tier, drawn from `tierMix`), `upgradeRate`, `downgradeRate`. The generator emits the upgrade invoice; the engine is unchanged. Code, medium |
| 5 | **Constant churn.** One `churnRate` for all months, tiers and ages | Churn is usually higher in the first months and differs by tier; a single rate hides that | `params.ts:90-95`; `generate.ts:362-363` | `churnByTier` weights and, optionally, `firstYearChurnRate`. Code, small |
| 6 | **No credit consumption model.** Usage is "a chance to book a class, per class credit, at most 3 a month", one unit per booking | AI credits and witnessed receipts are Trifold's metered revenue and its largest variable cost. 500–1,500 credits per Rifo close can't be booked one unit at a time | `params.ts:120-125`; `generate.ts:410-425`; the store's `consume` always tracks `value: 1` (`src/scenario/store.ts:265-290`), though the engine's `track` takes any value | `usage: { [featureId]: { meanPerMonth, byTier? } }` and `consume({ value })`. A top-up add-on bought when a balance runs out (`topUpAddon`). Code, medium |
| 7 | **Cash basis only: no MRR, ARR or deferred revenue.** | Investors and pricing decisions read MRR, ARR, expansion and churned MRR. On cash basis a yearly payment is a spike; `paying_members` falls to 0 in months with no yearly renewal | `docs/scenarios.md`, "Dropped, and why"; `ROADMAP.md:146` (owner decision open); `payment.succeeded`'s payload has no interval (`src/billing/money.ts:198-210`), although the invoice line has one (`generate.ts:344`) | The fix `docs/scenarios.md` proposes: `interval` and `period_end` labels on `payment.succeeded`, from the invoice line. Then MRR is a KPI spec entry (a yearly payment counted as amount / 12 in each month to `period_end`) — but that spread is a new spec operation, not a `sum`. Code in the production write path, plus a payload schema change and every golden. Needs the owner's decision |
| 8 | **No expenses beyond Stripe and disputes.** | Without COGS and opex there is no gross margin, operating income, burn or runway | The only expense accounts are `expenses:billing:stripe-fees`, `:disputes`, `:dispute-fees` and `:b4uni-share` (`src/ledger/postings.ts:197-277`) | Section 4. Code, medium |
| 9 | **Partner passthrough (the bundle).** | The plan counts only Trifold's ~$149 of the ~$349 bundle. Booked as one income line, gross collected overstates revenue by about $200 per bundle | No partner account exists. `share.accrued` is the shape to copy: `expenses:billing:b4uni-share` + / `liabilities:b4uni` − (`postings.ts:255-264`) | Model the bundle as Witnessed plus a `bookkeeper` add-on; book the partner's part as `expenses:billing:partner-share` against `liabilities:partners:<partner>`; add a `net_revenue` KPI (gross less refunds and partner share). Part of the expense work |
| 10 | **No metered revenue.** Event overage and Witness API receipts are post-paid usage | Small in years 1–2 (section 8 says "small"); 10–20% on top in year 3 | `docs/usage-metering.md`: metered pricing is out of scope; an invoice line the menu doesn't know refuses the invoice (`ROADMAP.md:152`) | Model as prepaid packs (one-time add-ons that grant credits), which is what `pricing-strategy.md` already sells through credits. Post-paid metering: outside tfd |
| 11 | **No cohorts.** | Net revenue retention, payback by cohort and conversion curves are cohort views | The KPI spec has `sum`, `count`, `distinct` (with `first`), `ratio`, `combine` (`schema/kpis.v1.json`); nothing groups holders by first-payment month | Outside tfd: DuckDB over the event Parquet, grouping by each holder's first `payment.succeeded`. A spec operation only if this becomes a dashboard |
| 12 | **SaaS KPIs missing.** MRR, ARR, NRR, logo churn, CAC, payback, gross margin, burn, runway | They are the outputs a 1–3 year plan is read by | `kpis/school.v1.json` has money, counts, rates, members, credits and balances only | Most become spec entries once gaps 7 and 8 are closed (table below). One file, `kpis/saas.v1.json`, and a `--kpis <file>` option (`runParity` already takes a `spec`, `src/scenario/parity.ts:73-86`; the CLI always passes the default) |
| 13 | **The Free tier can't be priced at $0, and the menu holds 4 tiers.** | Free, Starter, Pro, Witnessed and the bundle are five offers | `menu.v1.json`: `amount` minimum 50, `tiers` `maxItems` 4 | Four tiers: free (a nominal price, always invoiced at zero via `freeTier`), starter, pro, witnessed. The bundle is witnessed plus the `bookkeeper` add-on. No schema change |
| 14 | **Zero invoices leave no ledger event after the first month.** | Free schools can't be counted from the books month by month | `docs/scenarios.md`, "A renewal that moves nothing leaves no credit event"; `paying_members` counts payments only | Count active free schools from `credit.spent` (distinct holders with no membership payment), or report them from the generator's `stats`. A KPI entry or a stat |

### KPIs a SaaS model needs

| KPI | How | Needs |
|---|---|---|
| Gross margin | `combine`: net revenue less Stripe fees, COGS and partner share, then `ratio` over net revenue | Gap 8 |
| Operating income, burn | `combine` of revenue and every `expenses:` sum | Gap 8 |
| Cash on hand | Cumulative `sum` over `^assets:` with no dimension (as `credits_outstanding` is over credits) | An opening balance: a knob outside tfd, or an equity event later |
| Runway | Cash / burn | Outside tfd until there is an opening balance (a ratio of a cumulative and a monthly KPI is legal in the spec, but the opening cash isn't in the books) |
| CAC | `ratio`: `expenses:opex:marketing` / `new_paying_members` | Gap 8 |
| Payback (months) | CAC / (ARPA × gross margin) | Gaps 7 and 8 |
| MRR, ARR, new / expansion / contraction / churned MRR | Spread of each payment over its period | Gap 7 and a new spec operation |
| Logo churn | Holders paying last month and not this month | Gap 7 (yearly payers look churned otherwise); `plan.canceled` has no postings, so hledger can't count it (`docs/scenarios.md`, "Channel discrepancies found") |
| Net revenue retention | Cohort revenue now / the same cohort 12 months ago | Gap 11: outside tfd |
| Credits outstanding, breakage | Already in the spec | — |

## 4. Expenses

### Which costs, and what drives them

| Cost line | Driver | Variable or fixed | Account (proposed; matches existing naming) |
|---|---|---|---|
| Stripe fees on Trifold's revenue | Per payment: 2.9% + 30 cents | Variable | `expenses:billing:stripe-fees` (exists) |
| Dispute losses and fees | Per dispute | Variable | `expenses:billing:disputes`, `expenses:billing:dispute-fees` (exist) |
| Partner bookkeeper payouts | Per bundle per month | Variable | `expenses:billing:partner-share`, owed on `liabilities:partners:<partner>` until paid |
| AI tokens | Per credit consumed by Rifo | Variable | `expenses:cogs:ai-tokens` |
| Witness operations (key service, transparency log) | Per witnessed receipt and seal; a fixed floor | Mixed | `expenses:cogs:witness` |
| Hosting (Workers, R2, D1) | Per ledger event; a fixed floor | Mixed, small | `expenses:cogs:hosting` |
| Support | Per paying school, then a person | Mixed | `expenses:opex:support` |
| People | Salary schedule | Fixed | `expenses:opex:payroll` |
| Contractors | Schedule | Fixed | `expenses:opex:contractors` |
| Legal (license, trademarks, witness terms, partner contracts) | One-off and yearly | Fixed | `expenses:opex:legal` |
| Software and tools | Monthly | Fixed | `expenses:opex:software` |
| Marketing (CPA program, events, ads) | Budget | Fixed | `expenses:opex:marketing` |

Naming: the existing payment-processing costs live under `expenses:billing:`; keep them there. A separate `expenses:cogs:` root lets gross margin be one regex (`^expenses:(cogs|billing):`), and `expenses:opex:` makes operating expenses another. `incomeStatement` already picks up any new `expenses:` account as `otherExpenses` and as a line (`src/ledger/finance.ts:173-174`, `:693-702`, `:720-741`), so the finance views need no change.

The money side: today the cash accounts are `assets:stripe` and `assets:clearing:stripe-payouts`. Real bills are paid from a bank account, which needs a new `assets:bank` (or `assets:bank:<name>`). In a simulation, paying from `assets:clearing:stripe-payouts` is a reasonable stand-in.

### Option A: a layer outside tfd

A marimo notebook (or a DuckDB SQL file) reads `kpis.parquet` from `tfd scenario kpis` and adds COGS and opex from rate tables and a schedule.

- For: no tfd code at all; usable today; fast to change assumptions; fixed costs (payroll, legal) are naturally a schedule, not events.
- Against: the costs never reach the ledger, so hledger and the three-channel parity don't check them; per-credit and per-event costs have to be multiplied from monthly KPI totals, which loses the link to which member caused them; the result can't be a real P&L for a real business.

### Option B: cost drivers inside the scenario generator

The generator already knows every payment, credit spent and bundle. New knobs give a rate per driver, and the generator books the cost as events:
- `aiCostPerCreditMicros`: AI token cost per credit consumed.
- `hostingCostPerThousandEventsCents` and `hostingFixedCents`.
- `witnessCostPerReceiptMicros`.
- `partnerShare: { addon: "bookkeeper", percent: 100 }`: the passthrough.
- `opex: [{ account, monthlyCents, fromMonth, toMonth }]`: a fixed schedule.

Costs below a cent (a credit's tokens, an event's hosting) are summed per month and rounded once, half away from zero, then booked as one event per line per month. Postings are two-place USD, and the usage spike found that rounding per event loses about a quarter of the total (`docs/usage-metering.md`, "Rating").

- For: costs go through the ledger, so hledger, DuckDB and the tfd fold check them like revenue; gross margin, burn and CAC become spec entries; stays pure (rates are knobs, counts are what the run already made, no clock, no I/O).
- Against: needs an event type that can carry an expense (none of today's can, see below); one more set of goldens.

### Option C: an expense event type for real operating expenses

None of today's event types can book an arbitrary expense: `moneyPostings` has a fixed `switch` and throws on anything else (`src/ledger/postings.ts:189-292`), and `share.*` is fixed to `expenses:billing:b4uni-share` and `liabilities:b4uni`. A new type makes tfd's books able to hold a real P&L for any business, Trifold included:

- `expense.paid` (cash basis, like the rest of the books): `expenses:<tail>` + amount, `<paidFrom>` − amount. Payload: `account` (the tail, checked against `^(cogs|opex|billing):[a-z0-9-]+(:[a-z0-9-]+)?$`), `paid_from` (an `assets:` account), `amount` in cents, `vendor` as a category, never a person's name, `driver` label (`credit`, `event`, `payment`, `bundle`, `fixed`), `period` (`YYYY-MM`) for costs booked in arrears.
- Later, if the owner chooses accrual: `expense.accrued` / `expense.settled` against `liabilities:payable:<vendor>`, copying `share.accrued` / `share.settled` exactly.
- The partner passthrough uses the same type with `account: billing:partner-share`, or a `partner.accrued` / `partner.settled` pair if the bundle needs a statement per partner like `share` has (`src/ledger/share-statement.ts`).

Edits needed, the same list the usage spike found for a new type (`docs/usage-metering.md`, "Envelope fit"): the `event_type` enum in `schema/envelope.v1.json`; `AtmEventType` in `src/types.ts:92-129`; a `case` in `moneyPostings`; `schema/payload/expense.paid.v1.json` and `bun schema/build.ts`; the source in `defaultSource` (`postings.ts:294-304`). The KPI channels need nothing: none of them names an event type in code (`src/scenario/channels/*.ts`), they read postings.

How a real expense arrives stays outside the library: a CLI command (`tfd expense add --account opex:legal --amount 150000 --date 2027-02-03 --vendor law-firm`) or the family service writing to the outbox as it writes its own commands. The library only builds the event with `ledgerEvent`, a pure function. A later step could map Stripe's own invoices for Trifold's vendors, but that is not needed for a plan.

### Comparison

| | A: notebook | B: generator drivers | C: expense event |
|---|---|---|---|
| tfd code | none | knobs + generator, needs C's event | event type, schema, CLI |
| Costs checked by three-channel parity | no | yes | yes |
| Real P&L for a real business | no | no (simulation only) | yes |
| Fixed opex | easy | as a schedule knob | as real bills |
| Keeps "pure, no clock, no I/O" | n/a | yes | yes (I/O in the CLI) |
| Time to first number | a day | after C | — |

### Recommendation

Do all three, in this order, because each is small and the later ones reuse the earlier:
1. **A now** (phase 0): the notebook gives the section 8 outlook with costs in a day, with no tfd change, and becomes the check for B later.
2. **C next, minimal** (phase 5a): `expense.paid` only, cash basis. It's the one piece that also serves real businesses, and B needs it.
3. **B on top** (phase 5b): the generator emits `expense.paid` for its drivers; the notebook's cost lines move into the ledger one by one and must match.

Keep in the notebook for good: opening cash, runway, cohorts, NRR, and anything that is a judgment rather than a fact about money moving. Don't build accrual (`expense.accrued`, payables) until the owner decides the cash-basis question (`ROADMAP.md:146`), because it's the same decision as deferred revenue.

Scope, honestly: this section is a plan. Nothing in it is built.

## 5. The plan

| Phase | What | Files | Rough size |
|---|---|---|---|
| 0 | Notebook model outside tfd: section 8's counts, prices and costs as tables; monthly revenue, COGS, opex, burn, runway | New notebook outside `packages/atm` (for example `docs/business/model.py`, marimo) | 1 day, no tfd code |
| 1 | Pass a menu in. Menu-derived `tierMix` and `tierCounts` keys, features for usage and expiry. A Trifold menu fixture | `src/scenario/generate.ts`, `params.ts`, `profiles.ts`, `fixture.ts`, `cli.ts`, `school.ts`; `fixtures/billing/menu/trifold.json`; tests | ~250 lines + tests; every golden's `fixtureHash` moves if the menu enters the hash |
| 2 | Scale and growth: raise the caps; `joinsByMonth`; a planning mode with no round trip; `churnByTier` | `params.ts`, `generate.ts`, `cli.ts`, `src/scenario/roundtrip.ts` (skip), tests | ~150 lines |
| 3 | Lifecycle and usage: `freeTier`, `conversionRate`, `upgradeRate`, `downgradeRate`; credit consumption per feature with `value` > 1; top-ups when a balance runs out | `generate.ts`, `store.ts`, `params.ts`, tests | ~300 lines |
| 4 | `interval` and `period_end` labels on `payment.succeeded`; MRR, ARR, logo churn KPIs (a spread operation in the spec) | `src/billing/money.ts`, `schema/payload/payment.succeeded.v1.json`, `schema/kpis.v1.json`, the three channels, `kpis/` | ~300 lines; every golden moves. **Owner decision first** |
| 5a | `expense.paid` event type; `tfd expense add` | `schema/envelope.v1.json`, `src/types.ts`, `src/ledger/postings.ts`, `schema/payload/expense.paid.v1.json`, CLI, tests | ~200 lines |
| 5b | Cost drivers in the generator (`aiCostPerCreditMicros`, hosting, witness, `partnerShare`, `opex` schedule) | `params.ts`, `generate.ts`, tests | ~200 lines |
| 6 | `kpis/saas.v1.json` (net revenue, COGS, gross margin, opex, operating income, cash, CAC, active free schools) and `--kpis <file>` | `kpis/saas.v1.json`, `cli.ts`, parity tests | ~150 lines, mostly JSON |

Phases 1–3 are useful on their own (revenue under Trifold's menu); 5–6 add the P&L. Phase 4 can wait: phase 0's notebook can compute MRR from the plan's counts in the meantime.

### Worked example: a 36-month Trifold run

Every value is an assumption. Knobs marked "new" don't exist yet; the phase that adds them is in brackets.

**Menu** (`fixtures/billing/menu/trifold.json`, phase 1):

| Id | Kind | Price | Grants |
|---|---|---|---|
| `free` | tier | 50 cents nominal, always invoiced at zero (`freeTier`) | 200 `credit` a month, rollover 1 month |
| `starter` | tier | $29 a month, $290 a year (assumption: the pricing doc gives no Starter yearly price) | 1,000 `credit` a month, rollover 1 month |
| `pro` | tier | $79 a month, $790 a year | 5,000 `credit`, rollover 1 month |
| `witnessed` | tier | $149 a month, $1,490 a year | 8,000 `credit`, rollover 1 month |
| `bookkeeper` | add-on, monthly | $200 (makes the ~$349 bundle with Witnessed) | none |
| `compliance-pack` | add-on, monthly | $20 (assumption, middle of $15–30) | none |
| `credits-1000` | add-on, once | $10 | 1,000 `credit` |
| `witness-1000` | add-on, once | $30 (Witness API pack, low end of $0.03–0.05) | 1,000 `credit` |

**Knobs:**

| Knob | Value | Note |
|---|---|---|
| `months`, `start` | 36, `2027-01` | Assumption: phase 1 of the plan starts in January |
| `members` | 10 | The design-partner schools, paying from month 1 |
| `joinsByMonth` (new, 2) | 35 a month in year 1, 200 in year 2, 730 in year 3 | Sign-ups land on `free` |
| `freeTier` (new, 3) | `free` | |
| `conversionRate` (new, 3) | 0.02 a month | Free → paid, drawn from `tierMix` |
| `tierMix` | `starter` 40, `pro` 35, `witnessed` 25 | Section 8's mix, the bundle inside Witnessed |
| `addonRates` (new, 3) | `bookkeeper` 0.2 of Witnessed (5% of paying), `compliance-pack` 0.3 | |
| `upgradeRate`, `downgradeRate` (new, 3) | 0.01, 0.003 a month | |
| `churnRate` | 0.02 a month paid; free schools 0.03 (new, 3) | |
| `yearlyShare` | 0.15 | |
| `usage` (new, 3) | `credit` per month: free 50, starter 300, pro 1,500, witnessed 3,000 | Witnessed: ~100 receipts × 3, a seal, a Rifo close |
| `refundRate`, `disputeRate` | 0.01, 0.002 | |
| `feePercent`, `feeFixedCents` | 2.9, 30 | Exist today |
| `aiCostPerCreditMicros` (new, 5b) | 4,000 (0.4 cents a credit, 40% of face) | Assumption; replace with measured token cost |
| `hostingFixedCents`, `hostingCostPerThousandEventsCents` (new, 5b) | 5,000 a month, 5 | Assumption, generous; R2 storage alone is under a cent a school (`pricing-strategy.md` section 3) |
| `partnerShare` (new, 5b) | `bookkeeper` 100% | Trifold keeps the $149 Witnessed price |
| `opex` (new, 5b) | software $300/mo; legal $15,000 over months 1–6, then $500/mo; support contractor $2,000/mo from month 13; marketing $1,000/mo year 1, $3,000 year 2, $8,000 year 3; one hire at $8,000/mo from month 19, two more from month 28 | All assumptions; founder pay left out |

Why the growth knobs matter: with today's constant `newMembersPerMonth` and 1.5% monthly churn, reaching ~1,000 paying schools at month 36 needs about 35 new paying schools a month (35 × (1 − 0.985^35) / 0.015 ≈ 960). The same rate puts about 360 paying schools at month 12 (35 × (1 − 0.985^11) / 0.015), against the plan's 50.

Rough check of the year-end counts with these knobs (hand arithmetic, to tune against the run): year 1 ends with about 300 free and 50 paying (10 partners plus ~3 conversions a month); year 2 about 2,000 free and 270–300 paying; year 3 about 8,000 free and 1,000–1,300 paying. That's about 11,600 members created, which is why phase 2's caps and planning mode come before anything else in this run.

**What it would output, per month** (`kpis.json` and `kpis.parquet`):
- Revenue: `gross_collected`, `revenue_by_tier:<tier>`, `revenue_by_kind:membership|addon`, `refunds`, `net_revenue` (new).
- Members: `paying_members`, `new_paying_members`, `arpa`, active free schools (new), and with phase 4 `mrr`, `arr`, `logo_churn`.
- Credits: `credits_granted`, `credits_consumed`, `credits_expired`, `breakage_rate`, `credits_outstanding`.
- Costs: `stripe_fees`, `dispute_fees`, `partner_share`, `cogs` (AI, witness, hosting), `gross_margin`, `opex` by account, `operating_income`, `cac` (all new except the first two).
- Cash: `payouts`, cash on hand (new). Runway and NRR from the notebook.

**What month 36 should roughly show**, from section 8's assumptions (hand arithmetic, not a run): 1,000 paying schools × ~$76.50 subscription ≈ $76,500, plus ~$2,500 credit packs (about $2.50 per paying school), plus ~$10,000 bookkeeper passthrough (50 bundles × $200), so gross collected ≈ $89,000 and net revenue ≈ $79,000. Costs: Stripe ≈ $3,000; partner share $10,000; AI ≈ $6,000 for paying schools (1,500 credits average × 1,000 × 0.4 cents) plus ≈ $1,600 for 8,000 free schools; hosting under $1,000. Gross margin about 85% of net revenue. Opex in month 36 ≈ $35,000 with the schedule above, so operating income is positive by year 3 under these assumptions and negative through most of year 2.

## 6. What this doesn't cover

- Self-hosted (Community) schools: they never touch Trifold's Stripe account, so no ledger can see them. Count them, if at all, from verifier traffic or downloads, outside tfd.
- Taxes, sales tax on SaaS by state, and income tax.
- Fundraising and equity. tfd has `fundraise.*` for Zeffy donations, which is not equity.
- Price response (how conversion changes when a price changes). That is Pricing Lab's forward forecast (`pricing-strategy.md` section 7), which would build on phases 1–4.
