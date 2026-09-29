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

## 2. Inventory & livestock — `POST /api/inventory/ingest`

What's physically on hand, at an estimated market price. **Use snapshot mode** — an emptied bin must stop counting.

| Field | Required | Notes |
|---|---|---|
| `external_id` | yes | One per bin / lot / herd group |
| `item_class` | | `crop` (default) · `market_livestock` · `breeding_livestock` · `other` |
| `commodity` | yes | `"Canola"`, `"Bred cows"`, `"Calves"` |
| `quantity`, `unit` | yes | `bu`, `tonnes`, `head` |
| `price_per_unit` | yes | Current estimated market price per unit |
| `quantity_contracted` | if you know it | How much of *this bin* is already sold. If omitted for every row of a commodity, Money Hub nets out open contracts of the same commodity + unit instead |
| `location`, `as_of`, `segment`, `notes` | | `segment` defaults to `grain` for crops, `livestock` for animals |

Only the **uncontracted** quantity counts toward equity — contracted grain is counted once, as the contract. Breeding stock is never netted.

Safety: an empty snapshot is refused unless the body also has `"confirm_empty": true`.

```json
{ "source": "quarter-section", "snapshot": true, "items": [
  { "external_id": "bin-07", "commodity": "Canola", "quantity": 8000, "unit": "bu",
    "price_per_unit": 14.50, "quantity_contracted": 5000, "location": "Bin 7" }
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
