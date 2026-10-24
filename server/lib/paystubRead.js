// Reading a paystub (Jake, 2026-10-24: Ashley's agent works at a computer, so it files a stub the way a
// person would: "Add paystub" on the Paystubs panel with the PDF or a photo). Claude reads it into the same
// fields the paystub API takes; from there it's normalizeStub → saveStub like any other stub: matched to the
// deposit of its net pay, booked as wages, analysed. Needs ANTHROPIC_API_KEY.
import { normalizeStub, saveStub, DEDUCTION_TYPES } from './paystubs.js';

const MODEL = process.env.PAYSTUB_MODEL || process.env.RECEIPT_MODEL || 'claude-sonnet-5-5';

const PROMPT = (owner) => `This is a Canadian paystub (pay statement) for ${owner === 'jake' ? 'Jake' : 'Ashley'} Gayler. Read it and call record_paystub with what it PRINTS. Never calculate or guess a figure: leave out anything the stub doesn't show.
{
  "is_paystub": <false if this isn't a paystub or pay statement>,
  "employer": <who paid it, as printed>,
  "pay_date": <the date paid / cheque or deposit date, "YYYY-MM-DD">,
  "period_start": <pay period start "YYYY-MM-DD", or null>,
  "period_end": <pay period end "YYYY-MM-DD", or null>,
  "gross": <THIS period's gross pay (the current column, not year to date)>,
  "net": <THIS period's net pay: what was deposited>,
  "deductions": [<every deduction in THIS period's column: {"type": one of ${Object.keys(DEDUCTION_TYPES).join(', ')}, "label": <as printed>, "amount": <positive>}>],
  "ytd": <the year-to-date column if printed: {"gross", "net", "income_tax", "cpp", "cpp2", "ei", "pension", …}, else null>,
  "hours": <hours paid this period, or null>,
  "hourly_rate": <regular rate per hour, or null>,
  "notes": <anything unreadable or odd, else "">
}
Federal and provincial income tax are both "income_tax" (list them separately with their labels). CPP2 (second additional CPP) is "cpp2". A pension plan (SHEPP, MEPP, LAPP, PSPP, an RPP) is "pension"; a group RRSP is "rrsp". Health, dental, life and disability premiums are "benefits". A taxable benefit that isn't money (shown as earnings and taken back) is not a deduction: say so in notes.`;

async function claude(body) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error?.message || `Claude API ${res.status}`);
  if (out.stop_reason === 'refusal') throw new Error('The reader declined this document.');
  if (out.stop_reason === 'max_tokens') throw new Error('The reading was cut off. Try again.');
  return out;
}

/** The stub's fields as Claude reads them (the paystub API's shape). */
export async function readPaystub({ bytes, mime, owner }, { send = claude } = {}) {
  // A PDF goes as it is; a photo goes upright and in strips like a receipt (receipts.js loads the image library).
  const documentBlocks = mime === 'application/pdf'
    ? async () => [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } }]
    : (await import('./receipts.js')).documentBlocks;
  const tools = [{
    name: 'record_paystub', description: 'Record the fields read from the paystub.',
    input_schema: { type: 'object', properties: { is_paystub: { type: 'boolean' } }, required: ['is_paystub'], additionalProperties: true },
  }];
  const userTurn = { role: 'user', content: [...(await documentBlocks({ mime, image: bytes })), { type: 'text', text: PROMPT(owner) }] };
  let body = await send({ model: MODEL, max_tokens: 4000, tools, messages: [userTurn] });
  let tool = (body.content || []).find((c) => c.type === 'tool_use');
  if (!tool) {
    body = await send({ model: MODEL, max_tokens: 4000, tools, messages: [userTurn,
      { role: 'assistant', content: body.content?.length ? body.content : [{ type: 'text', text: '(no answer)' }] },
      { role: 'user', content: 'Call record_paystub now with what you can read.' }] });
    tool = (body.content || []).find((c) => c.type === 'tool_use');
  }
  if (!tool?.input) throw new Error("The paystub couldn't be read. Try a clearer photo or the PDF.");
  return tool.input;
}

/** Reads an uploaded paystub and files it. Throws { status, message } for a document it can't use. */
export async function fileUploadedPaystub({ bytes, mime, owner = 'ashley' }, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY && !opts.send) throw Object.assign(new Error('Paystubs are read with Claude: set ANTHROPIC_API_KEY first.'), { status: 503 });
  const read = await readPaystub({ bytes, mime, owner }, opts);
  if (read.is_paystub === false) throw Object.assign(new Error(`That doesn't look like a paystub${read.notes ? `: ${read.notes}` : ''}.`), { status: 422 });
  const { stub, warnings, error } = normalizeStub({ ...read, owner, source: 'upload', external_id: null });
  if (error) throw Object.assign(new Error(`Read the stub but ${error.replace(/\.$/, '')} — enter it again with a clearer copy.`), { status: 422 });
  const r = await saveStub(stub, warnings, { bytes, mime });
  return { id: r.id, updated: r.updated, matched_deposit: !!r.matched_transaction_id, warnings, employer: stub.employer, pay_date: stub.pay_date, net: stub.net };
}
