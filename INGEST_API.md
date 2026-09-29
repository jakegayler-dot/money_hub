# Money Hub — Ingest API

How outside systems (Quarter Section, Livestock Manager, scripts) push data into Money Hub.

## Common rules (all three endpoints)

- **Auth:** header `X-Api-Key: <INGEST_API_KEY>` — the same value set in Money Hub's server environment. Store it as an environment variable on the pushing side; never hardcode it.
- **Content type:** `application/json`.
- **Idempotent:** every item needs a stable `external_id` (its permanent ID in *your* system). `source` + `external_id` is the dedupe key, so keep `source` constant (e.g. `"quarter-section"`). Re-pushing an existing item updates it in place.
- **Snapshot mode (inventory and estimates):** send `{ "source": "...", "snapshot": true, "items": [...] }` with your *complete current list*. Anything from that source missing from the push is removed (inventory) or retired (estimates). Recommended pattern: push the full list on a schedule; no change tracking needed.
- **Response:** `{ received, results: [{ external_id, ok, id | error }] }`. A bad item doesn't fail the batch — check each `ok`.
- **Errors:** `401` bad key · `503` Money Hub's key isn't set · `400` malformed request.
- **Never fabricate a field.** If you don't know a value, omit it. A guessed date or quantity silently puts money in the wrong month.

---

## 1. Sale contracts — `POST /api/contracts/ingest`

Committed money in. Array of contracts (no snapshot mode — cancel explicitly).

| Field | Required | Notes |
|---|---|---|
| `external_id` | yes | |
| `commodity` | yes | `"Canola"` — must match the inventory commodity name for automatic netting |
| `total_value` | yes* | *or send `quantity` + `price_per_unit` |
| `quantity`, `unit` | recommended | Needed so Money Hub can net contracted grain out of bin inventory |
| `delivery_date` | when confirmed | Payment is derived as **delivery + 7 days** |
| `contract_period_end` | always | Last day of the delivery window; payment date when no delivery is scheduled |
| `expected_payment_date` | only if actually known | Ignored whenever a delivery date or period end is present |
| `status` | | `open` · `delivered` · `cancelled` (never `settled` — that happens in Money Hub when cash lands) |
| `counterparty`, `segment`, `notes` | | `segment` defaults to `grain` |

## 2. Inventory — `POST /api/inventory/ingest`

What's physically on hand: grain in bins, bale stacks, livestock. **Use snapshot mode** — an emptied bin or a fed-out stack must stop counting.

| Field | Required | Notes |
|---|---|---|
| `external_id` | yes | One per bin / stack / lot / herd group — stable across pushes |
| `item_class` | | `crop` (default) · `forage` (bales, silage) · `market_livestock` · `breeding_livestock` · `other` |
| `commodity` | yes | `"Canola"`, `"Barley"`, `"Hay"`, `"Straw"`, `"Bred cows"` — must match contract and price-list names |
| `quantity`, `unit` | yes | `bu` / `tonnes` for grain, `bales` for forage, `head` for animals |
| `price_per_unit` | only if you actually have one | **Omit it if you don't know it.** Money Hub values the item from its own price list; with no price anywhere it counts at $0 and is flagged — never at a guess |
| `quantity_contracted` | if you know it | How much of *this bin* is already sold. If omitted for every row of a commodity, Money Hub nets open contracts of the same commodity + unit instead |
| `location`, `as_of`, `notes` | | |
| `segment` | | Owner. Defaults: `crop` → grain; `forage` and animals → cattle (hay is produced for the herd). Override per item, e.g. straw sold off the grain side |

Only the **uncontracted** quantity counts toward equity — contracted grain is counted once, as the contract. Breeding stock is never netted.

**Scoped snapshots:** add `"scope": ["crop"]` (or `["forage"]`, or both) to limit snapshot cleanup to those classes. Without a scope, a snapshot replaces *everything* from that source — so if grain and bales are pushed separately, each push must carry its own scope or the second will delete the first. Items outside a push's scope are rejected.

Safety: an empty snapshot is refused unless the body also has `"confirm_empty": true`. The response lists any commodities still without a price in `needs_price`.

```json
{ "source": "quarter-section", "snapshot": true, "scope": ["crop", "forage"], "items": [
  { "external_id": "bin-07", "item_class": "crop", "commodity": "Canola", "quantity": 8000, "unit": "bu",
    "quantity_contracted": 5000, "location": "Bin 7" },
  { "external_id": "stack-north-hay", "item_class": "forage", "commodity": "Hay", "quantity": 640, "unit": "bales",
    "location": "North yard", "notes": "1,400 lb rounds" }
]}
```

### 2a. Prices (optional feed) — `POST /api/inventory/prices/ingest`

If a system has current bids or market prices, it can keep Money Hub's price list up to date. Otherwise prices are maintained by hand on the Assets tab.

```json
{ "source": "quarter-section", "items": [
  { "commodity": "Canola", "unit": "bu", "price_per_unit": 14.50, "as_of": "2026-09-28" },
  { "commodity": "Hay", "unit": "bales", "price_per_unit": 95 }
]}
```

## 3. Cash estimates — `POST /api/estimates/ingest`

Money you *expect* but that isn't backed by a contract, invoice or loan schedule — e.g. projected calf sales, uncontracted production, feed costs. Counted in every "with estimates" figure, never in "committed only".

| Field | Required | Notes |
|---|---|---|
| `external_id` | yes | |
| `name` | yes | |
| `direction` | yes | `inflow` · `outflow` |
| `amount` | yes | Per occurrence, always positive |
| `start_date` | yes | First (or only) occurrence |
| `frequency` | | `one_time` (default) · `monthly` · `quarterly` · `annual` |
| `end_date` | | Last possible occurrence for recurring estimates |
| `segment` | | `grain` · `livestock` · `jake` · `ashley`; or `is_segment_split: true` with `segment_grain_pct`, `segment_livestock_pct`, `segment_jake_pct`, `segment_ashley_pct` summing to 100 |
| `category`, `notes`, `status` | | `status: "retired"` stops it counting |

**Don't double count:** only estimate the *uncommitted* portion. Once production is under contract, push the contract and drop (or reduce) the estimate — in snapshot mode, simply leave it out of the next push and it's retired automatically. Occurrences dated in the past stop counting on their own.

---

## Quarter Section setup brief (paste this to Quarter Section)

> Build an automatic export from Quarter Section to Money Hub's ingest API.
>
> - **Endpoint:** `POST {MONEY_HUB_URL}/api/inventory/ingest` with header `X-Api-Key: {INGEST_API_KEY}` — both from environment variables, never hardcoded.
> - **When:** after any change to bin or bale-stack counts, and once daily as a safety net.
> - **Payload:** one snapshot of *everything currently on hand* — every grain bin and bale stack that currently holds product (leave empty bins and fed-out stacks out; Money Hub removes them):
>   `{ "source": "quarter-section", "snapshot": true, "scope": ["crop", "forage"], "items": [...] }`
> - **Per grain bin:** `external_id` (permanent bin ID), `item_class: "crop"`, `commodity` (same spelling as on contracts, e.g. "Canola"), `quantity`, `unit: "bu"`, `location`, and `quantity_contracted` if Quarter Section knows how much of that bin is committed to a contract.
> - **Per bale stack:** `external_id` (permanent stack/lot ID), `item_class: "forage"`, `commodity` ("Hay", "Straw", "Greenfeed"...), `quantity`, `unit: "bales"`, `location`, and bale type/weight in `notes`.
> - **Do not send `price_per_unit` unless Quarter Section has a real price** — Money Hub prices from its own list. Never estimate one.
> - **Check the response:** each item has `ok: true/false`; log failures. `needs_price` lists anything Money Hub can't value yet.
> - Contracts keep going to `/api/contracts/ingest` as before — inventory and contracts are separate pushes.
