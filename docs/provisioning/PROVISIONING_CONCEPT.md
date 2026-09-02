# Provisions and stores — a concept for the resource layer

**Status: concept, not plan.** Written 2026-08-14 from Ash's brief ("a resource
management system — period-correct, manageable as a game, every resource has to
justify its existence") plus two web-research passes over primary and secondary
sources (§11). Nothing here is implemented and nothing is a commitment; the
gameplay model (embodied captain / bird's-eye / crew orders) is **deliberately
undecided** and this document is written to survive any of those choices. Ash
owns scope, tiers and the open calls in §10.

Companion authorities it defers to: `docs/ship/SHIP_SPEC.md` (the vessel),
`docs/ship/SHIP_BELOW_DECKS_PLAN.md` (where things stow),
`docs/world/WORLD_MODEL.md` (time), and the two-clock rule from the sailing
project (actions are charged to the clock that pays for them).

Companion concepts:
- `docs/provisioning/CREW_COMFORTS_CONCEPT.md` — alcohol's actual role
  (dose, ceremony, discipline, the drunkard), music/gambling/the internal
  economy, and the morale calendar. Confirms this document's
  spirits/beer/tobacco calls; source material for the eventual crew morale
  round.
- `docs/provisioning/PAY_AND_MONEY_CONCEPT.md` — wages, the wage book, coin
  and bills aboard, the pay-off as endgame accounting. Money is a ledger and
  a port interface, never a gauge; the slop-book side of this document's
  Tier 1 lands there.

---

## 1. The ship we are provisioning

The repo already fixes more of this system than expected. These are canonical
facts, not proposals:

| Fact | Where |
|---|---|
| Complement **exactly 8**, all multi-functional (captain/player, master-mate, boatswain-carpenter, 2 ABs, sailor-cook, surgeon-naturalist, astronomer) | `docs/ship/SHIP_SPEC.md` §11 |
| Late-18th-century ex-merchant schooner converted for expedition service | `SHIP_SPEC.md` §1 |
| **4.8 t fresh water = 150 days at 4 L/person/day**, in modeled casks | `SHIP_BELOW_DECKS_PLAN.md` §3, `src/vessel/schooner/holdStow.ts` |
| **4.2 t "salt provisions and dry stores"** as one lump mass | `src/vessel/schooner/massModel.ts` |
| Bread room + lazarette under the cabin/landing floors; lockable **spirit locker** on the landing; **steward's pantry**; galley hearth in the forecastle; **sail room + boatswain's/carpenter's stores** in the peak | `SHIP_BELOW_DECKS_PLAN.md` §4 |
| The hold stow is modeled **cask by cask** (two nested tiers, dunnage, quoins), reachable down the wardroom hatch | `holdStow.ts` |
| Two clocks: 1× for the boat under your hands, 30× (`DEFAULT_REAL_MINUTES_PER_WORLD_DAY = 48`) for the calendar and distance made good | `src/world/clock.ts` |
| Embodied interaction exists (walking below, Space = use) | below-decks assets round |
| Lamps are real lights already driven by the day–night cycle | interior lighting rounds |
| "Stores and exchange items" are canonically **one or two generic secured chests**; the phrase "trade goods" is banned; **no armament, so no gunner's stores** | `SHIP_SPEC.md` §12–13 |

Two happy consistency checks against the research, worth recording because
nobody planned them:

- **Our 4 L/person/day is the historical envelope.** US 1802 regulations set a
  minimum of ½ gallon (2.3 L) *drinking* water per man per day on foreign
  voyages, with cooking water on top (~1.5 L at USS *Constitution*'s scale) —
  ≈ 3.8 L. Colonial expedition practice (*Lady Nelson*, 1800) budgeted 1 gallon
  (4.5 L) per man per day all purposes. We sit exactly between.
- **The 4.2 t provisions lump is a credible year.** Royal Navy full ration is
  roughly 9 kg/day of bread + meat + dry stores for 8 people; with cask and
  brine tare, 4.2 t is ~10–12 months — matching the "9 months provisions,
  6 months water" fit-out recorded for the survey vessels *Lady Nelson* (60 t,
  15 men) and *Mermaid* (84 t, 19 souls). Water, not food, was and is the
  binding constraint. Her 150-day water endurance **is** the range of the ship.

And one modeled detail that turns out to be the natural unit of the whole
system: the stow's casks work out at **~60 L each — the crew broaches a water
cask about every second day**, and ~80 casks is the full 150-day load. "Count
the casks" and "count the days" are the same act. (Historically right, too: a
74-gun ship's ground tier alone was 148 casks; small handy casks were what a
small crew could shift.)

---

## 2. How it actually worked

Digest of the research, arranged for design use. Attestation is flagged where
it is weak; everything unflagged is well-attested (multiple independent sources
or primary ship's papers — order books of US frigates 1799–1816, RN purser's
instructions, and the small-vessel narratives of Flinders, Grant and P.P. King.
The US order books are bigger ships than ours, but the practices are the
common Anglo-American ones and scale down; the small-vessel records confirm it).

### 2.1 The ration was a calendar, not a menu

Royal Navy weekly scale per man (stable in essentials from Pepys to Napoleon):
**1 lb of ship's biscuit every day**, plus a rotation —

| Day | Issue |
|---|---|
| Sun, Thu | 1 lb salt pork + ½ pint dried peas |
| Tue, Sat | 2 lb salt beef |
| Mon, Wed, Fri | "banyan days" (meatless): oatmeal, butter, cheese (peas on Wed/Fri) |

— nominally ~5,000 kcal/day. Beer (1 gallon/day) was the home-waters drink and
soured within weeks; foreign service substituted wine or spirits at the codified
rate (1 pint wine or ½ pint spirits = 1 gallon beer). **Grog** (from 1740):
½ pint of rum cut 4:1 with water, mixed in a tub on deck under an officer's
eye and issued **twice daily**, names checked off a list. Nothing aboard was
drunk neat by right.

Meals: breakfast = burgoo (oatmeal + molasses) or "Scotch coffee" (burnt
biscuit boiled in water); **dinner at noon was the one hot meal**; supper was
cold leftovers, tea if the weather allowed. Salt meat went into the **steep
tub** the evening before to soak, water changed every four hours — and if the
tub washed overboard in a gale the cook swore an oath to the number of pieces
lost so the books balanced.

Biscuit is Ash's "dried bread": triple-baked, ~4 oz each, 3–4 per man-day,
rated to keep five years, stowed in bags/bins in the **bread room** — the space
the below-decks plan already reserves, in the same place HMS *Beagle* kept hers.

### 2.2 The ledger and the hold were different things — by design

This is the finding that shapes the whole system:

- The purser legally kept **an eighth of everything** (the 14 oz "purser's
  pound", until 1797 — its abolition was a Nore mutiny demand). Casks arrived
  short-filled. Quality varied by cask.
- Issues happened in **fixed windows through a locked door** — the first
  lieutenant held the storeroom key and handed it to the steward 07:00–10:00
  and 16:00–19:00; spirits were pumped from the spirit room under a master's
  mate's supervision at 11:30.
- **Every cask broached got a mini-survey** (representatives of captain,
  master, purser: quantity and quality, condemnation formally logged).
- **Every Saturday the master and carpenter walked every storeroom** looking
  for "leaks, damps, vermin, or any other cause" (*Independence* order book,
  1815).
- And the sailing master handed the captain **a daily paper of "the
  expenditure of stores and water remaining"** — days-of-stores-remaining was
  literally recomputed every morning. Our resource HUD has an exact diegetic
  ancestor.
- Running low had a formal instrument: **short allowance** (two-thirds, then
  half), logged per man because the crew was *owed money* for undelivered
  ration ("short allowance money"). USS *Constitution* 1813: two-thirds
  provisions and **three pints of water a day** — "the men could not eat the
  salt grub without water" — drove her to Juan Fernández. When Bainbridge cut
  bread and water without explanation the crew came aft "in a mutinous manner";
  he explained the reason and they went below.

On a merchant or small vessel there was no purser: **the master doubled as
purser**, the mate kept the expenditure log, a steward or the cook did the
issuing. Mapped to our roster: **the mate keeps the ledger, the steward's
pantry issues, the cook steeps and burns fuel, the boatswain-carpenter owns the
craft stores, the surgeon-naturalist owns the medicine chest** — the canonical
eight cover the whole system with nobody invented.

### 2.3 The day and the week had a shape

The consumption drivers are not abstract rates; they are visible scenes at
fixed hours (all from ship's order books):

| Hour | Scene | Burns |
|---|---|---|
| 04:00 | watch washes decks (salt water), pump ship until it "sucks" | — |
| 07:30 | hammocks up, 10–12 min; bedding aired on deck "when weather permits" | — |
| 08:00 | breakfast, 30 minutes exactly | fuel, dry stores, water |
| 10:00 | surgeon's rounds; sick list into **the binnacle drawer** | — |
| 11:30 | grog mixed at the tub; "seven-bell men" eat early | spirits, water |
| 12:00 | **dinner** — the hot meal, one full hour | fuel, salt meat (steeped since last evening), peas/oatmeal, water |
| ~13:30 | steward issues tomorrow's dry provisions through the locked door | (ledger event) |
| 16–18:00 | second grog; supper = cold leftovers | spirits |
| evening | tomorrow's salt meat into the steep tub; casks shifted, next day's water whipped up | water |
| sunset | hammocks down; lamps lit | oil |
| 20:00/21:00 | **lights out** (winter/summer); binnacle lamp burns on | oil (trickle) |

Weekly: Monday slops issue (monthly, first Monday — clothing sold from stores
against wages, 5 s/man/month cap); Thursday make-and-mend, all hands shaved,
clean shirt; Saturday **wash-clothes day** (water boiled from 04:00, lines rove
between the shrouds) *and* the storeroom survey; Sunday divisions, inspection,
and no work but sailing the ship. Laundry was normally **salt water** — soap
barely lathers in it and salt-washed clothes never fully dry; fresh water for
washing was near-contraband (Jervis had captains reprimand women for it in
1796), which makes the Saturday boiled-water wash a real policy choice. Nobody
bathed in any modern sense; cleanliness was enforced by inspection. Heads on a
vessel our size: a "spice box" seat forward, buckets at night.

Damp is the constant enemy: bedding aired daily when possible, lower decks
scrubbed with vinegar and fumigated with burning brimstone, hammocks scrubbed
fortnightly, dry-sand scrubbing when ports couldn't open.

### 2.4 One fire, few lights

- The galley fire (an iron **camboose** stove — ours is drawn at the aft end of
  the forecastle, historically correct) was **the only fire aboard**. It was
  doused at lights-out, at quarters, and in heavy weather — hence cold suppers,
  and in a long gale a cold ship on cold food.
- The cook manages the firewood; ships stopped for **"wood and water"** as one
  errand. Fuel quantity is the one number the research could not pin for our
  era (best anchor: a full 1904 warship galley burned "up to ½ ton of coal a
  day", flagged as extrapolation — a camboose for eight plausibly burns
  10–20 kg/day; it needs a tonnage line in the stowage plan either way,
  because a passage's fuel is *bulky*).
- Light was scarce and disciplined: whale/train oil lamps and tallow "purser's
  dips"; **lights out 20:00–21:00 with the master-at-arms checking four times a
  watch**; no naked light near spirits or powder (big ships had a glazed
  **light room** precisely so no flame entered the magazine). A small vessel
  keeps perhaps three lights: binnacle (all night — navigation), cabin,
  one lantern below. Per-lamp consumption: no period figure found; a flat-wick
  lamp burns ~10–20 ml/hour (modern measurement, flagged) → **~0.3–0.5 L of
  oil per ship-night**. Oil is never a bulk problem; it is a fiction and
  failure-texture line, not a logistics one.

### 2.5 The scurvy clock is real arithmetic

Body vitamin-C stores run ~4–6 weeks after fresh food stops; clinical onset
typically **60–90 days** (lassitude → bleeding gums, skin changes → old wounds
reopening); ~10 mg/day prevents entirely; recovery on citrus takes **days**
(Banks dosed himself with lemon juice on *Endeavour* and his gums recovered
inside a week). Cook's arsenal: sauerkraut at 2 lb/man/week (7,860 lb carried),
portable soup 1 oz/man on banyan days, malt wort for the symptomatic, spruce
beer brewed at wooding stops — and the famous adoption trick: the men refused
kraut until Cook served it at the cabin table, then demanded it. The Admiralty
mandated lemon juice (¾ oz + 2 oz sugar per man per day, into the grog) only
in **1795** — Haslar's scurvy admissions fell from ~1,500 to 2 in twenty years.
Our fiction sits in the couple of decades *before* that mandate: antiscorbutic
policy is **captain's discretion, contested science** — which is a gift to a
game whose player is the captain. Merchant service (our hull's origin) lagged
decades behind.

### 2.6 Things went wrong as events, not curves

Home-fleet spoilage statistics are boring on purpose — ~0.3% of bread condemned
1750–57 (Rodger). What broke voyages was discrete and narratable:

- **Rats gnawed through 2 of the last 3 water casks** on P.P. King's survey
  cutter *Mermaid*, 1819 — a primary-source near-loss of the voyage, at exactly
  our vessel scale.
- Weevils (and the 20 mm "bargemen" larvae) in wetted bread — tap it out, eat
  in the dark, or condemn the bag.
- Water stinks anaerobically, then **recovers** — Fryer, 1698: stand it
  unbunged on deck 24 hours "it recovers its goodness". Rain catchment works
  but the first catch off tarred canvas is undrinkable.
- Casks broached short (the eighth), salt meat mostly bone and gristle ("salt
  junk" took a polish like wood), condemned butter re-issued to grease the
  rigging.
- The steep tub washed overboard, certified on oath.

### 2.7 Craft stores at our scale

The single best like-for-like record found: the whaling **schooner *Lydia*,
Edgartown 1765**, outfitted for ~13 months with — among much else — 600 fathoms
of tow line, spare rigging by the coil, **nails by the count** (500 pump, 600
board, 1,500 shingle…), a full carpenter's tool roll, **20 lb of candles** and
2 barrels of rum. A vessel our size carried: boatswain's stores (cordage,
canvas bolts, twine, tar, pitch, blocks, old junk for oakum and chafing gear),
carpenter's stores (plank, oakum, nails/spikes, sheet lead for leaks, white
lead, tools), a **spare suit of sails** (old patched suit worn in fair weather,
best suit bent on for heavy), and a **medicine chest** — for ships below
surgeon-size, law and practice was a numbered-bottle chest administered by the
master from a printed book (US law required the chest from 1790; annually
refreshed). Frigate *Essex*, 1799, carried a **6¼-gallon keg of lemon juice**
in the surgeon's stores — the chest and the scurvy policy meet in one object.
Slops (clothing, bedding), soap and tobacco (2 lb/man/month cap) were all
issued from stores against wages in one ledger, settled at pay-off.

---

## 3. Design principles

Seven rules before any list. These are the argument of this document; the
tiers in §4 are just their output.

- **P1 — A line earns its slot or it doesn't exist.** The test: does it create
  a *decision* (rationing, route, policy), stage a *scene* (issue, survey,
  grog tub), or make a *failure narratable* (rats, scurvy, dark ship)? A
  resource that only ever ticks down in a menu fails the test.
- **P2 — Pools, not SKUs.** The long tail is real but aggregated: "carpenter's
  stores" is one number spent by repairs, not forty items. Itemize only what
  the player's hands or eyes touch (casks you can count, the spirit locker,
  the medicine chest as an object).
- **P3 — Routines consume automatically; the player sets policy and handles
  exceptions.** Nobody refills lamps as a chore. The crew runs the §2.3
  timetable on its own; the captain's verbs are policy (ration scale, grog
  scale, lights-out hour, laundry water, antiscorbutic issue) and exception
  (survey, condemn, explain). This is also how the system stays agnostic to
  the gameplay-model decision — policies work identically from a HUD or from a
  conversation with the mate.
- **P4 — The ledger is the interface; the hold is the truth.** All numbers the
  player normally sees are the mate's book, which drifts (short casks, leaks,
  rats, the eighth). Surveys reconcile it. "Go below and take an inventory" is
  gameplay *because* the book can be wrong — uncertainty is the mechanic, and
  it is period-native (§2.2).
- **P5 — Rates live on the world clock.** Consumption is per world-day
  (`clock.ts`, 48 real minutes each); errands (a survey, a watering party, a
  re-stow) charge world time under the two-clock rule exactly like sail
  evolutions. Nothing consumes per real second.
- **P6 — Spoilage is events, not decay curves** (§2.6). Steady rot is
  bookkeeping; a rat-holed cask discovered at Saturday survey is a story.
- **P7 — Mass is real.** The stores the crew eats are 7+ tonnes of the mass
  model at known heights; a long passage genuinely lightens and re-trims her.
  Not a launch feature — but the coupling is nearly free later
  (`massModel.ts` already itemizes), and no design here may contradict it.

---

## 4. The roster, in tiers

### Tier 0 — the daily burn (seven gauges)

The survival loop. Every line burns on the §2.3 timetable, is visible somewhere
aboard, and has a distinct running-out consequence. Rates are for 8 souls, per
world-day, at full allowance.

| # | Line | Physical form / where | Burn | Full stow lasts | Running out means |
|---|---|---|---|---|---|
| 1 | **Fresh water** | ~80 × 60 L casks, hold (modeled) | 32 L | 150 d | short allowance → thirst; **the route decision** |
| 2 | **Bread (ship's biscuit)** | bags in the bread room | 3.6 kg | ~150 d at ~550 kg | the staple gone; flour stretches it, hunger follows |
| 3 | **Salt meat (beef & pork)** | ~10 barrels, hold | 3.1 kg avg | ~150 d | every day a banyan day; strength and morale sag |
| 4 | **Dry provisions** (peas, oatmeal, flour, butter, cheese, sugar/molasses) | sacks/kegs, hold + bread room | ~2.5 kg | ~150 d | monotony diet; breakfast dies; scurvy accelerates |
| 5 | **Spirits** | a butt + working breaker, spirit room/locker (drawn) | 2.3 L | ~150 d at ~350 L | grog stops: the loudest morale event aboard (full treatment: `CREW_COMFORTS_CONCEPT.md`) |
| 6 | **Galley fuel** (wood/coal) | fore hold / deck cords | ~10–20 kg ⚠ | needs a stowage decision | cold food, cold ship, damp uncontested |
| 7 | **Lamp oil** (+ candles, folded in) | one ~60 L cask + jars, lazarette | ~0.4 L/night | ~150 nights | a dark ship — the emotional target inverted; binnacle must burn |

⚠ = the one poorly-attested rate (§2.4); tune freely.

Notes against Ash's specific questions: the bread is biscuit and the bread
room already exists on the plan; the "alcohol in a cupboard" is the spirit
locker, also already drawn; **lamps stay automatic** (P3) — oil is a stock the
lamps draw down by lit-hours, never a refilling chore. Beer is deliberately
absent (§4's refused list): an expedition vessel victualled with spirits, and
one morale-liquid is enough.

### Tier 1 — health and morale (five lines)

The layer that makes the voyage *long* rather than merely finite.

| Line | Form | Mechanic it carries |
|---|---|---|
| **Antiscorbutics** (kraut kegs, lemon-juice jugs, essence of spruce) | kegs/case | the scurvy clock (§2.5): per-person fresh-food timers; issue policy is captain's discretion in our era — the game's best "believe the science or don't" decision |
| **Fresh provisions & livestock** | days-since-port stock + countable heads (hens, a goat, a pig fattening on scraps) | resets scurvy timers; decays; livestock is the visible, audible version of it on deck |
| **Tobacco** | rolls in the slop chest | small comfort economy; issue capped 2 lb/man/month; a currency when it runs short |
| **Hygiene stores** (soap, vinegar, brimstone) | pantry/lazarette | laundry policy (salt vs fresh), fumigation after sickness, damp control |
| **Slops** (clothing & bedding bale) | slop chest | crew wear out clothes; monthly issue against wages; ragged crew in cold water is a health modifier |

### Tier 2 — the working ship (four pools + one inert)

All P2 pools, spent by other systems (sail damage, leaks, sickness), owned by
roster members:

- **Boatswain's stores** — cordage, canvas, twine, tar, blocks; spent by rig
  wear and weather damage; lives in the sail room/peak (drawn). Sailmaking is
  folded in (one owner aboard anyway); the **spare suit of sails** is the one
  discrete item worth keeping visible.
- **Carpenter's stores** — plank, oakum, pitch, nails, sheet lead; spent by
  hull strain, leaks (the pump well is already real), the odd sprung seam.
- **Medicine chest** — one object, numbered bottles abstracted to a pool +
  the lemon-juice keg (crosses over to antiscorbutics); spent by injury and
  sickness events; owned by the surgeon-naturalist.
- **Galley & pantry gear** — *not* a gauge; a condition flag at most (the
  steep tub can be lost; the coppers exist). Listed to say it stays set
  dressing.
- **Exchange chests** — already canonical (`SHIP_SPEC.md` §12), stays one or
  two secured chests, inert until some future shore round.

### Tier 3 — refused, with reasons

Recorded so later sessions don't re-litigate: **beer** (expedition practice
went to spirits; one liquid morale line is enough); **gunner's stores** (spec
§13: no armament); **itemized medicines** (the chest is a pool; naming forty
tinctures is museum work); **per-garment clothing** (slops is a bale);
**per-cask quality simulation** (P6 — events carry quality); **money and
prices aboard** (accounts are notional until pay-off; port economy is a
different round's decision); **livestock feed** (folded into dry-stores loss);
**candles as a separate line** (folded into lamp stores); **the distilling
stove attachment** (period-real, big-ship kit); **officers' private stores**
(the captain's wine is pantry set dressing, not a gauge).

---

## 5. The routine engine

The point of §2.3 is that **routines are simultaneously the consumption
driver and the life of the ship**. Even with zero management gameplay wired
up, the timetable is worth simulating because it *stages the crew*: hammocks
up at 07:30, the grog tub at 11:30, laundry lines between the shrouds on
Saturday, the master and carpenter disappearing down the fore hatch with a
lantern. The spec's emotional target — "a warm, lamplit wooden home carrying
eight familiar people" — is mostly *made of these scenes*, and the future crew
system (`docs/sailing/SAILING_S5_HUMAN_CREW_HANDOVER.md` reserves the slot)
gets its daily script for free.

Mechanically the engine is small: a world-clock scheduler that walks the daily
and weekly tables, debits the Tier-0 gauges, and emits scene hooks something
visible can subscribe to later. Policies are its parameters:

| Policy dial | Settings | What it touches |
|---|---|---|
| Ration scale | full / two-thirds / half | food burn, morale, short-allowance money owed |
| Grog | full / watered / stopped | spirits burn, morale; stoppage doubles as punishment |
| Water discipline | free scuttlebutt / measured / pint-per-day | water burn, grumbling |
| Laundry water | salt (free, damp, itchy) / boiled fresh (costs gauge 1) | hygiene, morale |
| Lights-out hour | early / regulation / indulgent | oil burn, fire risk, mood below |
| Antiscorbutic issue | none / banyan-days / daily | kraut/juice burn, scurvy clocks |
| Banyan compliance | keep the rotation / meat every day | meat vs dry-stores burn ratio |

Weather couples in three places, all cheap: the galley fire is doused in heavy
weather (hot meals stop, fuel doesn't burn), rain enables catchment (bounded,
first catch spoiled off tarred canvas), and bad weather blocks bedding-airing
(damp accumulates).

---

## 6. Gameplay sketches

Model-agnostic; each works whether the captain walks or clicks.

**6.1 The mate's morning report.** At 08:00 world time the mate's sheet gives
days-remaining per gauge *at current allowance* — computed from the **ledger**,
not the truth (P4) — plus yesterday's expenditure and anything the routine
surfaced. This is the resource HUD, it is diegetic paper, it has a direct 1815
ancestor, and it belongs behind the existing HUD pill.

**6.2 The survey.** Ash's founding wish — "go down and check the hold" — is the
reconciliation mechanic. The weekly Saturday survey runs automatically and
cheaply (crew-quality error bars); the captain doing it in person walks the
actual stow (`holdStow.ts` renders every cask), counts, and gets the true
number. Discoveries happen here, not when they occur: the rat-holes are found
on Saturday, which is exactly the right dramatic beat. Broaching events
(every ~2 days for water) give a fine-grained trickle of quality moments
without any extra system.

**6.3 Short allowance.** One dial, historical fractions, two consequences:
endurance stretches (arithmetic, shown in the next morning's report) and the
crew's temper shortens — moderated by *whether the cause is visible* (Bainbridge
explained; the grumbling stopped). Short-allowance money accrues as a promise
against pay-off. This is the most game-shaped object in the whole research:
pressure, lever, cost, all period-native.

**6.4 Wood and water.** The port loop and the reason landfalls matter: watering
parties rafting casks off (Flinders did exactly this from the 25-ton *Norfolk*),
wooding, spruce-beer brewing, airing everything, re-stowing the hold. All
errands charged to the world clock. The water gauge is the range of the ship
(§1), so the chart, the terrain round's anchorages, and this system close into
one loop: **where you can go is what you can carry.**

**6.5 The event deck.** Every card from a primary source, resolved through
existing verbs (survey, condemn, policy): rat-holed casks (*Mermaid*); a cask
broached short (the eighth); weevily bread — condemn the bag or eat in the
dark; water foul — stand it unbunged 24 h and it recovers; rain catchment —
but the first catch is tarry; steep tub overboard — meat lost, sworn on oath;
condemned butter to the boatswain for rigging grease (a Tier-1 loss becoming a
Tier-2 credit is a lovely little economy).

**6.6 The scurvy arc.** Per-person timers off fresh food (§2.5's real numbers),
visible stages, antiscorbutics as the brake, citrus as the near-miraculous
cure — and because our fiction predates the 1795 mandate, *whether to believe
in any of it* is the captain's call, with the surgeon-naturalist as the
in-fiction advocate. Cook's cabin-table trick is a ready-made mechanic for
crew adoption of disliked issue.

**6.7 The slop book** (deferred design). Clothing wear, monthly issue, every
man's drawings against wages settled at pay-off — a whole quiet economy that
wants the crew round to exist first. Noted so it isn't forgotten.

---

## 7. Fits and frictions

- **The spec's "no crew-management" sentence** (`SHIP_SPEC.md` §1). As
  designed here — P3, policy-first, crew autonomous — the resource layer does
  not contradict it: the captain steers policy, nobody schedules anybody's
  shift. But Ash's brief openly wonders about bird's-eye control of crew; if
  the gameplay round lands there, that sentence needs renegotiating **in the
  spec**, not silently overriding.
- **Pacing is the load-bearing open question.** At 30×, 150 water-days is
  ~120 real hours of sailing; the 60–90-day scurvy fuse is 48–72 real hours.
  Either voyages are genuinely long-haul (many sessions — possibly right for
  the Kairosoft register) or a voyage-skip/sleep mechanism eventually exists.
  **Every rate in §4 is tuned against that decision**, so it should be made —
  or explicitly deferred — before any implementation round. (The two-clock
  rule itself is settled; this is about how much world time a play-session
  covers.)
- **Mass model.** Itemizing the 4.2 t lump and debiting mass on consumption is
  the cheap, honest coupling (P7) — but it perturbs trim and the ballast
  solve, so it is its own later round with hydrostatics eyes on it. Galley
  fuel needs a mass/stowage line in `SHIP_BELOW_DECKS_PLAN.md` regardless —
  1–3 t of firewood for a long passage is real bulk the plan doesn't carry.
- **No commerce.** Resupply is victualling, not trading; `SHIP_SPEC.md` §12's
  ban on "trade goods" stands untouched.
- **The rooms get their verbs.** Bread room, spirit locker, pantry, sail room,
  medicine chest: every storage space the below-decks plan drew acquires a
  reason to walk to it. Conversely nothing here demands a new compartment
  except the fuel decision above.
- **Sources caveat.** Much of §2.3's timetable detail is US frigates 1799–1816
  (the best surviving order books); RN and small-vessel records agree where
  they overlap, but our fiction should feel free to adapt hours and ceremonies
  to an eight-person schooner rather than cite a frigate.

---

## 8. If Ash wants a first round: "the ledger round"

The smallest implementable slice that proves the system's feel, needing **no
crew AI, no ports, no morale model**:

1. `ProvisionsState` — the seven Tier-0 gauges with cask/bag discreteness for
   water, meat and spirits; rates driven by the routine scheduler on the world
   clock. Headless-testable: run 150 world days, water hits zero on schedule;
   set two-thirds allowance, endurance stretches by exactly the fraction.
2. **The mate's morning report** as the surface (dev shell first, HUD pill
   when it earns it) — reporting the ledger, with drift.
3. **The survey verb** — reconcile ledger to truth at the modeled stow;
   embodied if cheap, a command if not (the difference is presentation, and
   deciding it is a useful probe of the whole gameplay-model question).
4. Two or three §6.5 events, no more.

Non-goals for that round, stated now: scurvy, morale, resupply, slop accounts,
mass coupling, any crew rendering. Each has its section above waiting.

---

## 9. Open questions for Ash

1. **Pacing** (§7): how much world time should a play-session cover, and is a
   skip/sleep mechanism ever on the table? Gates all rate tuning.
2. **Discreteness taste**: casks-and-bags you can count (recommended for
   water/meat/spirits) vs smooth gauges everywhere?
3. **The ration rotation as visible fiction** — "Tuesday: salt beef day" on
   the report? Recommended: it's free calendar texture.
4. **Lamp oil**: confirm the P3 answer (auto-burn, stock exists, no chore).
5. **Beer**: confirm the refusal (spirits carry the morale-liquid role).
6. **Morale's address**: this system emits the events (grog stopped, short
   allowance, cold food); does morale itself live here or wait for the crew
   round? Recommendation: wait — emit now, consume later.
7. **The survey's embodiment** (§8.3) — walk or command? This small decision is
   the gameplay-model question in miniature and might be the cheapest way to
   feel out the answer.

---

## 10. Burn-rate appendix

For tuning reference, 8 souls, full allowance, world-day rates with period
anchors:

| Line | Rate | Anchor |
|---|---|---|
| Water | 32 L/d | canonical 4 L/man; US 1802 min ½ gal drinking + cooking ≈ 3.8 L; colonial 1 gal all-purpose = 4.5 L |
| Biscuit | 3.63 kg/d | RN 1 lb/man/day |
| Salt meat | 3.11 kg/d | RN 6 lb/man/week (4 beef + 2 pork) |
| Dry provisions | ~2.5 kg/d | RN peas/oatmeal/butter/cheese weekly scale + sugar |
| Spirits | 2.27 L/d | ½ pint/man/day, grog 4:1 water |
| Galley fuel | 10–20 kg/d ⚠ | extrapolated (§2.4) |
| Lamp oil | 0.3–0.5 L/night ⚠ | modern flat-wick ~10–20 ml/h × ~3 lamps |
| Sauerkraut (when issued) | 0.52 kg/d | Cook: 2 lb/man/week |
| Lemon juice (when issued) | 0.17 L/d | 1795 scale: ¾ oz/man/day |
| Scurvy | onset 60–90 d; ~10 mg/d prevents; cure in days | §2.5 |

A useful sanity anchor the other way: at these rates a 90-day passage for
eight costs ~2.9 t water, ~0.33 t biscuit, ~0.28 t meat, ~0.2 t spirits — she
comes home **over four tonnes lighter** even before fuel, which is why P7 is
worth having eventually.

---

## 11. Sources

Load-bearing primary/near-primary: Brenckle, *Daily Routine at Sea* and *Food
and Drink in the U.S. Navy 1794–1820* (USS Constitution Museum — verbatim ship
order books); RN Purser's Instructions via piratesurgeon.com and McBride,
*Minding their Ps and Qs* (2019); "A Rum Deal: the purser's measure" (*Business
History*, 2016); Kodicek & Young, *Captain Cook and Scurvy* (1969); Grant's
*Lady Nelson* narrative and Flinders' *Norfolk* narrative (gutenberg.net.au);
P.P. King's *Mermaid* letter book (SL NSW); Slocum, *Sailing Alone Around the
World*; Dana, *Two Years Before the Mast* and *The Seaman's Friend*; Frayler,
*The Medicine Chest* (NPS Salem); the 1765 *Lydia* outfit (Vineyard Gazette);
Scammon's whale-ship stores list (whalesite.org); *Provisioning of USS
Constitution* (incl. the 1813 short-allowance cruise).

Secondary: Naval Gazing "Naval Rations"; History Hit on Georgian navy diet;
USNI on scurvy and rum; Smithsonian "Beer on Board"; SNR on cask supply
1770–1815; Hektoen "Of toerags and spice boxes"; British Tars on laundry;
stove-history material on the camboose/Brodie stove; The Dear Surprise on
weevils and pay.

Weakest links, flagged where used: galley fuel rate (1904 extrapolation),
lamp-oil rate (modern measurement), leaguer capacity variance, urine-laundry
(unconfirmed for our era — omitted), exact end of banyan days.
