# Money Hub — Ingest API

How outside systems (Quarter Section, Livestock Manager, scripts) push data into Money Hub.

## Common rules (all endpoints)

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
| `commodity` | yes | `"Canola"`, `"Barley"`, `"Hay"`, `"Straw"`, `"Bred cows"` — must match contract names so contracted grain nets out |
| `quantity`, `unit` | yes | `bu` / `tonnes` for grain, `bales` for forage, `head` for animals |
| `price_per_unit` | yes, for it to count | **Your system's own price estimate per unit** — the number Money Hub values the item at. Money Hub keeps no price list: an item sent without one counts at $0 and is listed in `needs_price`. Re-send it whenever your estimate changes |
| `quantity_contracted` | if you know it | How much of *this bin* is already sold. If omitted for every row of a commodity, Money Hub nets open contracts of the same commodity + unit instead |
| `expected_sale_date` | if you have one | When the *uncontracted* part is expected to sell. Optional — without it, grain uses its crop's estimate date (below), then Money Hub's fallback sell-by date |
| `location`, `as_of`, `notes` | | |
| `segment` | | Owner. Defaults: `crop` → grain; `forage` and animals → cattle (hay is produced for the herd). Override per item, e.g. straw sold off the grain side |

Only the **uncontracted** quantity counts toward equity — contracted grain is counted once, as the contract. Breeding stock is never netted.

**Scoped snapshots:** add `"scope": ["crop"]` (or `["forage"]`, or both) to limit snapshot cleanup to those classes. Without a scope, a snapshot replaces *everything* from that source — so if grain and bales are pushed separately, each push must carry its own scope or the second will delete the first. Items outside a push's scope are rejected.

Safety: an empty snapshot is refused unless the body also has `"confirm_empty": true`. The response lists anything pushed without a price in `needs_price` — those count at $0 until the next push carries one.

```json
{ "source": "quarter-section", "snapshot": true, "scope": ["crop", "forage"], "items": [
  { "external_id": "bin-07", "item_class": "crop", "commodity": "Canola", "quantity": 8000, "unit": "bu",
    "price_per_unit": 14.50, "quantity_contracted": 5000, "location": "Bin 7" },
  { "external_id": "stack-north-hay", "item_class": "forage", "commodity": "Hay", "quantity": 640, "unit": "bales",
    "price_per_unit": 95, "location": "North yard", "notes": "1,400 lb rounds" }
]}
```

---|---|---|
| `external_id` | yes | |
| `name` | yes | |
| `commodity` | for crop estimates | `"Canola"` — same spelling as inventory. Uncontracted grain already in the bins is forecast to sell on this estimate's date |
| `direction` | yes | `inflow` · `outflow` |
| `amount` | yes | Per occurrence, always positive |
| `start_date` | yes | First (or only) occurrence |
| `frequency` | | `one_time` (default) · `monthly` · `quarterly` · `annual` |
| `end_date` | | Last possible occurrence for recurring estimates |
| `segment` | | `grain` · `livestock` · `jake` · `ashley`; or `is_segment_split: true` with `segment_grain_pct`, `segment_livestock_pct`, `segment_jake_pct`, `segment_ashley_pct` summing to 100 |
| `category`, `notes`, `status` | | `status: "retired"` stops it counting |

**Inventory is forecast automatically.** Uncontracted grain in the bins and market cattle on hand already count as expected money in, at their manager's price, on: the item's `expected_sale_date` → else its crop's estimate date (matched on `commodity`) → else the fallback sell-by date on the Assets tab. So estimates should cover only what is **not in inventory yet** — e.g. bushels still in the field. As bins fill, lower the estimate by the bushels harvested; once a crop is all harvested, drop the estimate from the push (its date is still used for the binned grain).

**Don't double count:** only estimate the *uncommitted* portion. Once production is under contract, push the contract and drop (or reduce) the estimate — in snapshot mode, simply leave it out of the next push and it's retired automatically. Occurrences dated in the past stop counting on their own.

---

## 4. Bank and credit card statements — `POST /api/statements/ingest`

An agent reads a statement (PDF, screenshot, CSV export) and sends **every line exactly as the statement shows it**. Money Hub decides what each line is: it pays the matching bill, records the loan payment, settles the contract, pays down the card, pairs the transfer, or recognizes money already on file. Anything uncertain waits on the **Review** tab — it never touches a balance until a person approves it.

**One call per statement, one account or card per call.**

```json
{ "source": "statement-agent",
  "statement": {
    "external_id": "rbc-ops-4821-2026-09",
    "account_last4": "4821",
    "period_start": "2026-09-01", "period_end": "2026-09-30",
    "opening_balance": 94000.00, "closing_balance": 81497.15
  },
  "lines": [
    { "date": "2026-09-03", "amount": -120.00, "description": "COSTCO WHOLESALE #551",
      "splits": [ { "amount": -80, "category": "Groceries", "segment": "jake" },
                  { "amount": -40, "category": "Shop supplies", "segment": "grain" } ] },
    { "date": "2026-09-25", "amount": -1000.00, "description": "ETRANSFER RENT", "kind": "bill_payment", "payee": "Rent" },
    { "date": "2026-09-25", "amount": -2400.00, "description": "RBC VISA PAYMENT", "kind": "card_payment", "card_last4": "9876" }
  ] }
```

### Before you start: `GET /api/statements/reference`
Same `X-Api-Key`. Returns every account (with `last4`), card, category, owner, unpaid bill, upcoming loan payment and open contract. Use it to fill in `kind`, `category` and owner correctly. **Never invent a category** — use one from this list or leave it out. Categories have two levels: when a category has subcategories (`has_subcategories: true`), **use the most specific one** — "Diesel — dyed", not "Fuel & oil". Totals roll up to the parent automatically; the detail can't be recovered if it isn't entered.

### Statement header (`statement`)

| Field | Required | Notes |
|---|---|---|
| Account: `account_last4` · `account_id` · `account_name` | one of these, or a card | `account_last4` is best — set each account's last 4 digits on the Accounts tab |
| Card: `card_last4` · `credit_card_id` | one of these, or an account | |
| `external_id` | recommended | Stable id for this statement, e.g. `"rbc-ops-4821-2026-09"` |
| `period_start`, `period_end` | recommended | **Required for a card's first itemized statement** (`period_start`) |
| `opening_balance` | card's first statement | The statement's **"previous balance"**. Required the first time a card is sent, so its running balance starts from the right number |
| `closing_balance` | recommended | The statement's **closing / new balance**. Money Hub checks itself against it (see *Reconciliation*) |
| `historical` | backfill only | `true` for past statements: a bill, loan or contract payment with nothing on file to match is posted directly (bill → expense, loan → debt service, settlement → income) instead of waiting for review. See *Loading history* |
| `set_opening_balance` | backfill only | `true` on the **first** statement of each account/card you backfill: sets the balance on `period_start` to `opening_balance` and rebuilds today's balance from there. Needs `period_start` + `opening_balance` |
| `due_date`, `minimum_payment`, `interest_charged` | card statements | With `period_end` + `closing_balance` these log the billing cycle, so the amount due shows up in the cash forecast |

### Lines (`lines[]`)

| Field | Required | Notes |
|---|---|---|
| `date` | yes | `YYYY-MM-DD` — the posting date on the statement |
| `amount` | yes | **Your side of it: negative = money out / spent, positive = money in / credited.** On a card: a purchase is negative, a refund or payment received is positive |
| `description` | yes | Exactly as printed |
| `kind` | | `standard` (default) · `bill_payment` · `loan_payment` · `card_payment` · `contract_payment` · `transfer` · `owner_draw` — see below |
| `party` | **always, when the statement or receipt names one** | The business on the other side: who was paid, or who paid ("Federated Co-op", "Cargill", "Heartland Livestock", "SaskPower"). Recorded on the transaction so totals by payee and buyer work. Use one consistent name per business — check `payees` in `/reference` and reuse an existing name exactly |
| `payee` | | Plain-words hint for matching a bill, loan, contract or card ("Rent", "FCC", "Richardson Pioneer"). Also recorded as the party if `party` is missing |
| `gst` | **when the receipt or invoice shows it** | The GST amount printed on the receipt/invoice (positive number, included in `amount`). Exact figures only — never calculate or guess it; leave it out if there's no receipt. Zero-rated items (fertilizer, seed, crop protection, feed, grain and cattle sales) have none. Recorded on the transaction for the GST return |
| `category` | **always for money in** | Exact name from `/reference`. Categories have a `kind`: `expense` for money out, `income` for money in (e.g. "Canola sales", "Calf sales", "AgriStability", "Patronage dividends"). **Every deposit that isn't a transfer needs an income category** — without one it posts but waits on Review until a person picks one. Unknown names are held for review, not created |
| `segment` | | Owner: `grain` · `livestock` · `jake` · `ashley`. Default: the account's (or card's) owner. Or `is_segment_split: true` + the four `segment_*_pct` fields summing to 100 |
| `splits` | | One line, several pieces. Each: `amount` (same sign), `category`, `segment`, `memo`. **Pieces must add up to the line amount exactly** |
| `is_capex` | | Capital purchase |
| `card_last4` | `card_payment` from a bank | Which card was paid |
| `counterparty_last4` | `transfer` / `owner_draw` | The other account, if it's in Money Hub. Both sides are recorded at once |
| `from_account_id` | `card_payment` on a card | Only if the paying account's statement won't be sent |
| `needs_review`, `review_note` | | Set when **you** aren't sure — the line goes straight to Review with your note |
| `external_id` | | Optional. If omitted Money Hub fingerprints the line, so re-sending the same statement never double-enters |

### Kinds — what to send, and what Money Hub does

- **`standard`** — ordinary spending or income. Posted with its category/owner/splits/party. Income: use the most specific income category ("Wheat sales", not "Grain sales") and set the owner (`grain` / `livestock`).
- **`bill_payment`** — paying a bill that's on the Bills tab (utilities, rent, invoices). Matched to the unpaid bill with that exact amount due within 45 days; the bill closes and a recurring one rolls to next cycle. A bill paid on a card works too (send it on the card statement).
- **`loan_payment`** — a scheduled loan payment. Matched to the unpaid scheduled payment with that exact amount due within 20 days; recorded as debt service (kept out of operating expenses and coverage math).
- **`card_payment`** — from a bank statement: paying a credit card (send `card_last4`). On a card statement: the "PAYMENT — THANK YOU" line; it's matched to the bank-side payment and never counted twice.
- **Vendor owner splits** — a vendor with an owner split set in Money Hub (Bills → By vendor) splits every new line for it, named as the `party`/`payee` or in the description ("SASKPOWER PREAUTH"), whatever owner the line carried.
- **GST/HST with CRA** — a refund deposit or remittance that names GST/HST and CRA (or the Receiver General) is held on Review whatever `kind` says: approve it as a transfer and link it to its quarter on the Tax tab. Send it as `kind: "transfer"` to skip the hold. Personal GST/HST credit, carbon rebate and child benefit payments aren't caught.
- **`contract_payment`** — a grain/cattle settlement deposit. Send `contract_id` (from the reference's `open_contracts`) and it counts toward that contract. Without `contract_id` it waits on Review — Money Hub never guesses the contract. Deposits already in the ledger are linked with §6.
- **`transfer`** — money between accounts Money Hub tracks, or a loan advance. Not income or spending. When both statements are sent, the two sides pair up automatically.
- **`owner_draw`** — business account → owner. Recorded as a transfer and as an owner draw.

**If you're unsure of the kind, send `standard` with `needs_review: true` and a note.** A wrong kind is worse than a question.

### What happens to each line (`results[].status`)

- `posted` — new transaction recorded (and the bill/loan/contract/card updated).
- `matched` — this money was **already on file**: an outstanding cheque it cleared, a hand-entered transaction, or the other side of a transfer or card payment. Nothing new moved.
- `held` — waiting on the Review tab; `reason` says why and `candidates` lists what it might be. Common reasons: two bills for the same amount, unknown category, no matching scheduled item, possible duplicate, flagged by you, or the line is dated in a month that's been **closed** on the Books tab (closed months take nothing new until reopened).
- `ok: false` + `error` — unusable (bad date, zero amount). Fix and re-send.

Re-sending a statement is always safe: finished lines report `already_processed: true`; held lines are re-evaluated with whatever you send now.

### Reconciliation
With `closing_balance` and `period_end`, the response includes `reconciliation`: Money Hub's balance at `period_end` versus the statement's. `reconciled: true` means every dollar is accounted for. `explained_by_held: true` means the only gap is the lines waiting for review. Any other gap means a line was missed or misread — **re-check the statement before doing anything else.**

### Credit cards: itemized
The first statement sent for a card switches it to **itemized**: from `period_start`, its balance is the opening balance plus every purchase, refund and payment. Purchases count as expenses when made; payments become transfers (except the part that pays off the balance from before itemizing, which stays an expense so nothing disappears).

### Loading history
Money Hub stores each account's **current** balance, and every transaction moves it — so history can't just be dropped in. Do it in this order:

1. **Pick a start month.** 12–24 months back. Nothing in Money Hub uses older data.
2. **For each account, send its statements oldest → newest.** The oldest one carries `"historical": true, "set_opening_balance": true` with that statement's `period_start` and `opening_balance`; every later one carries `"historical": true` only.
3. **Within each month, send bank accounts before credit cards** — a card's "PAYMENT — THANK YOU" line is matched to the bank-side payment, which must already be in.
4. **Cards the same way:** the first card statement carries `set_opening_balance: true` and its "previous balance". A card's start can later move *earlier* (to load an older month) but never later.
5. **Check every `reconciliation`.** After the newest statement, each account's Money Hub balance should equal the bank's real balance today.

Anything you already entered by hand inside the history window is recognized and matched, not doubled. Past loan payments are recorded as debt service, but the *trailing-12-month* term debt coverage ratio reads loan payments from each loan's schedule — a loan entered at today's balance has no past schedule, so that ratio stays understated until the loan is entered with its original start date, principal and term.

---

## 5. Documents (photos and PDFs) — `POST /api/receipts/upload`

Attach a receipt, invoice, settlement ticket or contract document. Auth: `X-Api-Key` (the same `INGEST_API_KEY`) or `X-Receipt-Key` (`RECEIPT_UPLOAD_KEY`). The body is the file itself — raw bytes with `Content-Type: application/pdf` / `image/jpeg` (PNG, WebP, GIF also accepted; HEIC is refused — convert to JPEG), a multipart form field, or JSON `{"file": "<base64>"}`. Up to 25 MB.

Where it goes depends on the query string:

| Query | What happens |
|---|---|
| *(none)* | Read (when `ANTHROPIC_API_KEY` is set) and matched on its own: a receipt to its payment, an invoice to its payment or into Bills, a settlement ticket to its deposit and contract. |
| `?transaction_id=ID` | Attached to that ledger entry (several per entry allowed). Read first when a reader is set up, so the entry gets exact GST and the business — and a settlement ticket on a deposit splits it into gross sale and deductions and counts it toward its contract. |
| `?bill_id=ID` | Filed as that bill's invoice (not read); moves onto the payment when the bill is paid. |
| `?contract_id=ID` | Filed with that sale contract (the signed contract, an amendment) — kept, not read. |

Finding IDs: a statement import's `results[].transaction_id`; `GET /api/transactions?q=<text>&from=YYYY-MM-DD&to=YYYY-MM-DD` (also `account_id`, `credit_card_id`); `GET /api/bills`; `GET /api/contracts` (or the `id` returned by `POST /api/contracts/ingest`). All accept `X-Api-Key`.

Response: `201 {"id": <document id>, "ok": true, "message": "..."}`. Errors: 401 (key), 404 (no such entry/bill/contract), 415 (not an image or PDF).

## 6. Linking deposits to contracts — `/api/contracts/ingest/*`

Your agent decides which deposits pay which contract; Money Hub links nothing on its own and suggests nothing. Same `X-Api-Key`.

**`GET /api/contracts/ingest/reference`** (optional `?since=YYYY-MM-DD`, default 400 days back) returns:
- `open_contracts` — `id`, `external_id`, `counterparty`, `commodity`, quantity and price, `total_value`, `received_amount`, `remaining`, `delivery_date`, `expected_payment_date`, `status`, and `linked` (deposits already on it).
- `unlinked_deposits` — incoming ledger entries not on any contract: `transaction_id`, `date`, `amount`, `description`, `account`, `payee`.

**`POST /api/contracts/ingest/link`**
```json
{ "links": [
  { "transaction_id": 219, "contract_id": 37 },
  { "transaction_id": 228, "contract_external_id": "QS-2026-0042" }
] }
```
One object without `links` also works. Each link is applied on its own. A deposit already on a different contract moves to the new one; linking it again to the same contract is a no-op. The contract settles itself once its deposits reach its value less the checkoff allowance, and the gap is booked as deductions. Response `200` (all ok) or `207` (some failed): `{"results": [{transaction_id, contract_id, ok, status, received_amount, remaining} | {…, ok: false, error}]}`.

**`POST /api/contracts/ingest/unlink`** `{"transaction_ids": [219]}` takes entries off their contract. The entries stay in the ledger, and a contract that had settled reopens. Deposits recorded by hand on the Contracts tab can only be changed there.

## Quarter Section setup brief (paste this to Quarter Section)

> Build an automatic export from Quarter Section to Money Hub's ingest API.
>
> - **Endpoint:** `POST {MONEY_HUB_URL}/api/inventory/ingest` with header `X-Api-Key: {INGEST_API_KEY}` — both from environment variables, never hardcoded.
> - **When:** after any change to bin or bale-stack counts, and once daily as a safety net.
> - **Payload:** one snapshot of *everything currently on hand* — every grain bin and bale stack that currently holds product (leave empty bins and fed-out stacks out; Money Hub removes them):
>   `{ "source": "quarter-section", "snapshot": true, "scope": ["crop", "forage"], "items": [...] }`
> - **Per grain bin:** `external_id` (permanent bin ID), `item_class: "crop"`, `commodity` (same spelling as on contracts, e.g. "Canola"), `quantity`, `unit: "bu"`, `location`, and `quantity_contracted` if Quarter Section knows how much of that bin is committed to a contract.
> - **Per bale stack:** `external_id` (permanent stack/lot ID), `item_class: "forage"`, `commodity` ("Hay", "Straw", "Greenfeed"...), `quantity`, `unit: "bales"`, `location`, and bale type/weight in `notes`.
> - **Send Quarter Section's own price estimate as `price_per_unit` on every item** — it's the only price Money Hub uses (Money Hub keeps no price list). Re-push when the estimate changes, not just when counts do.
> - **Check the response:** each item has `ok: true/false`; log failures. `needs_price` lists anything pushed without a price — it counts at $0 until fixed.
> - **Unharvested production as estimates** (`POST /api/estimates/ingest`, snapshot mode, `"source": "quarter-section"`): one per crop with bushels still in the field — `external_id` like `"2026-canola-unharvested"`, `commodity` (same spelling as inventory), `direction: "inflow"`, `amount` = unharvested uncontracted bushels × your price, `start_date` = the date you expect that crop to be sold. **Binned grain of the same crop is forecast to sell on this same date**, so keep it meaningful. Lower `amount` as bins fill; when a crop is fully harvested, leave it out of the push (don't send `amount: 0`).
> - If you have a sale date for a specific bin, send it as `expected_sale_date` on that inventory item — it overrides the crop's date.
> - **Livestock Manager** follows the same spec with `"source": "livestock-manager"` and `"scope": ["market_livestock", "breeding_livestock"]`, one item per herd group, `unit: "head"`, its own per-head estimate as `price_per_unit`, and — for calves/feeders it will sell — `expected_sale_date` when known (otherwise Money Hub's fallback sell-by date is used).
> - Contracts keep going to `/api/contracts/ingest` as before — inventory and contracts are separate pushes.


---

## Statement agent brief (paste this to the agent that reads statements)

> You enter bank and credit card statements into Money Hub.
>
> - **Credentials:** `MONEY_HUB_URL` and `INGEST_API_KEY` from environment variables. Never hardcode or print the key.
> - **First:** `GET {MONEY_HUB_URL}/api/statements/reference` with header `X-Api-Key`. Use its accounts, cards, categories, owners, bills, loan payments and contracts — never invent any of them.
> - **Per statement:** one `POST {MONEY_HUB_URL}/api/statements/ingest` (spec: INGEST_API.md §4). Identify the account by `account_last4` or the card by `card_last4`. Send `period_start`, `period_end`, `closing_balance`, and for cards `opening_balance` (the "previous balance"), `due_date`, `minimum_payment`, `interest_charged`.
> - **Send every line**, amounts signed from the owner's side (money out negative). Copy dates, amounts and descriptions exactly.
> - **Label `kind`** only when the statement makes it clear (a named loan, a named bill, a card payment, a transfer between their own accounts). Otherwise `standard`.
> - **Split** a line only when you have the receipt showing the breakdown; pieces must sum to the line.
> - **Categories:** always the most specific one from `/reference` (a subcategory when one exists — e.g. "Diesel — dyed", not "Fuel & oil"). Money in gets an **income** category ("Canola sales", "Calf sales", "AgriStability") — never leave a deposit uncategorized unless it's a transfer.
> - **GST:** when you have the receipt or invoice, send its GST amount as `gst` — exactly as printed. No receipt, no `gst`.
> - **Party:** send `party` on every line that names a business — the same spelling every time (reuse names from `payees` in `/reference`).
> - **When unsure, set `needs_review: true` with a one-sentence `review_note`.** Don't guess a category, owner or kind.
> - **After each post, read `reconciliation`.** If it isn't `reconciled` or `explained_by_held`, re-read the statement for a missed or misread line and re-send (re-sending is safe). Report anything you can't resolve.
> - Report back: lines posted, matched, held (with reasons), and the reconciliation result for each statement.
>
> **Loading history (one-time backfill):** follow INGEST_API.md §4 *Loading history* exactly — per account, oldest statement first with `"historical": true, "set_opening_balance": true`, every later one with `"historical": true`; within a month, bank accounts before cards. Stop and report if any statement fails to reconcile rather than continuing on top of it.
