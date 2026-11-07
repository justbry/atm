# Scenario orgs: a studio, a church, a SaaS product and a course creator beside the school

The scenario generator (`docs/scenarios.md`) first simulated one demo organization: a school, shown on the website as Honeycomb Hill Academy (in the fixtures it is Before University, `sch_before_university`). Four more demo orgs now run through the same billing rules, the same books and the same three-channel KPI parity (the atm fold, hledger, DuckDB). Every name, price and id is invented. None of it is a real organization's data, and there are no keys.

Each org is one entry in `src/scenario/orgs.ts` with a menu in `fixtures/billing/menu/`. Each preset is a seed and some knobs in `src/scenario/profiles.ts`, and its KPI golden is in `tests/golden/scenarios/<preset>.json`.

## The orgs

| Org | Name | What it is | Menu |
|---|---|---|---|
| `school` (default) | Before University (on the website, Honeycomb Hill Academy) | a school: classes, workshops, coaching | `before-university.json` |
| `studio` | Ironbark Studio | a fitness and membership studio | `ironbark-studio.json` |
| `church` | Cedar Hill Community Church | a church or nonprofit | `cedar-hill-church.json` |
| `saas` | Lumen Notes | a SaaS or digital product | `lumen-notes.json` |
| `creator` | Night Kitchen Courses | a creator or online-course business | `night-kitchen-courses.json` |

## The presets

| Preset | Org | Seed | What it simulates |
|---|---|---|---|
| `studio-members` | studio | 201 | A year at Ironbark Studio. Forty founding members join, then three a month, on four memberships: off-peak (4 classes a month), core (12 classes, up to 4 carry over), class pack and all access. About one in seven pays annually. Drop-ins, ten-class packs and PT intro sessions are sold as add-ons. Unused classes roll over or expire, and about one member in sixteen cancels each month. |
| `studio-class-packs` | studio | 202 | Mostly class packs. A pack is five classes, bought one or two at a time; unused classes roll over for two months and then expire. Ten-class packs and drop-ins come on top. Some members buy a second pack mid-month, billed at once, and some drop back to one at renewal. Churn is higher than on a membership. Nine months. |
| `church-giving` | church | 301 | A year of giving at Cedar Hill. Sixty households give $25, $50, $100 or $250 a month, or the same amount yearly; about a quarter give yearly. Some add a one-time gift ($50 or $200), a gift to the new roof campaign (monthly or yearly) or a family retreat registration. A few mistaken gifts are refunded, often in part. Disputes are rare. Fees are at a nonprofit card rate (2.2% + 30¢). |
| `saas-seats` | saas | 401 | A year of Lumen Notes. There is a solo plan, plus team (3, 5 or 10 seats) and business (10, 25 or 50 seats) plans priced per seat; about a third prepay annually. Teams add seats mid-month, billed at once with proration, or drop seats at renewal. Some customers move up a plan (solo to team, team to business), billed at once with proration. API-call credits (blocks of 1,000 calls) are used every month, and API boost packs and support add-ons are sold on top. |
| `saas-annual` | saas | 402 | Lumen Notes sold annually. Every customer prepays a year on solo, team or business, over 24 months so that the renewals show. API credits are used every month, and churn is low. |
| `creator-launch` | creator | 501 | Night Kitchen Courses launches. Ninety members join the paid community in the launch month, then four a month. Many buy a course (sourdough, knife skills) or the recipe pack download at sign-up. Members book live cook-alongs. Refunds run high (about 7% of payments) and about one member in twelve leaves each month. |

`tfd scenarios list` shows every preset with its org, and `tfd scenarios describe <preset>` shows the org, its knobs and copy-paste commands.

```sh
tfd simulate --profile church-giving
tfd simulate --profile saas-seats --set seatChangeRate=0.3 --seed 9 --json
echo '{"org":"creator","params":{"members":40,"refundRate":0.1}}' | tfd simulate --scenario - --json
```

## Picking an org

A preset names its org. An ad-hoc scenario can give one at the top level: `{ "org": "studio", "params": { ... } }`. With no org, the scenario is the school's. An org's scenario starts from the same defaults as the school's, but `tierMix` weighs that org's own tiers. `tierMix` and `tierCounts` may name only the org's tiers. A wrong key gets the usual error, which names the knob, what was given, the org's tiers and the nearest match. An `org` that differs from its preset's is an input error.

## Two knobs for seat changes and upgrades

Both are off (0) by default. A scenario that leaves them at 0 carries neither one in its resolved knobs, so every school preset's fixture hash and golden stay byte-identical.

- `seatChangeRate`: in each monthly period (a day from the 3rd to the 20th of it, the sign-up month included), the chance that a family on a tier sold in quantities moves to the next count up or down. A raise is billed at once on a prorated `subscription_update` invoice, as the billing portal's `always_invoice` does. A decrease takes effect at the next renewal, as the portal schedules it.
- `upgradeRate`: in each monthly period (a day from the 3rd to the 20th of it, the sign-up month included), the chance that a family on a monthly price moves to the next tier down the menu list that costs more a month at the count it would take. The move is billed at once on a prorated `subscription_update` invoice (a credit line for the old plan and a charge line for the new one). The family keeps its seat count where the new tier sells it, or else takes the tier's smallest count above it, or its largest if none is.

Both are drawn from a stream of their own, so turning them on moves nothing else in a family's draws.

## Where an org is the closest honest fit, not an exact one

The generator and the billing engine were not extended for any org beyond the two knobs above. Where a real business works differently, this is the version that fits the menu shape:

- **Every customer is a member.** A one-time purchase (a drop-in, a one-time gift, a course, a recipe pack) rides as a one-time add-on on the member's **first** invoice. Nobody buys one without a membership, and nobody buys one later.
- **One add-on per member, at sign-up.** `addonRate` picks one: the recurring add-on for the member's interval, or one of the one-time ones. A member who gives to the roof campaign does not also make a one-time gift.
- **Add-on money is booked to the tier.** The books post a whole invoice to `income:billing:membership:<tier>`. A one-time gift or a course sale is not a separate income line, so a KPI split by tier counts it under the member's tier.
- **Church giving is recurring gifts at fixed amounts.** A tier is a giving level (the menu allows at most four). Pledges with a schedule, custom amounts and campaign goals are not modelled. Gifts grant no credits; the only credit is a seat at the family retreat.
- **The church's refunds are "mistaken gifts".** A refund lands on a random paid invoice (`refundRate`, part of them partial), not on a gift chosen as the mistake.
- **SaaS usage is credit blocks.** One API-call credit is a block of 1,000 calls. A member books at most three blocks a month (the generator's usage cap), so the usage numbers are small next to the grants. API credits on the seat tiers do not roll over. Seat changes and upgrades happen only on monthly plans, never on annual prepay.
- **Upgrades only go up.** `upgradeRate` never moves a customer down a tier. A decrease is a seat change at renewal.
- **Class packs are a tier sold in quantities.** "Buy one or two packs" is a monthly tier at a quantity of 1 or 2. Rollover keeps unused classes for two months, then they expire. The ten-class pack is a one-time add-on.
- **A launch spike is the founding month.** `members` is the launch cohort and `newMembersPerMonth` is the steady trickle after it. There is no per-month curve.
- **The ids are school-named.** The books carry an org's id where they carry a school's (`school`, the `b4u_school` invoice metadata), and holders are still `family:fam_NNN`. These identifiers are frozen.
