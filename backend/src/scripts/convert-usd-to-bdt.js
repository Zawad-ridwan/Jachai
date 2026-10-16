// OPTIONAL, one-off: converts old billing records from US dollars to taka, so the
// admin Finance totals don't mix currencies. Nothing runs unless you ask for it.
//
//   npm run convert:currency -- --rate 124            preview only (changes nothing)
//   npm run convert:currency -- --rate 124 --apply    convert for real
//
// --rate is how many taka one US dollar is worth. Each amount is converted as
// cents x rate = poisha (e.g. $9.99 at 124 becomes 1,238.76 taka).
// Back up backend/data/ first if you care about the exact old numbers.
import { db } from '../db.js';

const args = process.argv.slice(2);
const rateArg = args[args.indexOf('--rate') + 1];
const rate = Number(rateArg);
const apply = args.includes('--apply');

if (!args.includes('--rate') || !Number.isFinite(rate) || rate <= 0 || rate > 10_000) {
  console.error('Usage: npm run convert:currency -- --rate <taka per US dollar> [--apply]');
  process.exit(1);
}

const rows = db.prepare(`SELECT type, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
  FROM billing_events WHERE currency = 'usd' GROUP BY type`).all();
const count = rows.reduce((s, r) => s + r.n, 0);
if (!count) {
  console.log('No US dollar records found. Nothing to convert.');
  process.exit(0);
}

const fmt = (poisha) => `BDT ${(poisha / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
console.log(`Found ${count} US dollar billing record(s):`);
for (const r of rows) {
  console.log(`  ${r.type.padEnd(10)} ${String(r.n).padStart(4)}  $${(r.cents / 100).toFixed(2)}  ->  ${fmt(Math.round(r.cents * rate))}`);
}

if (!apply) {
  console.log('\nPreview only. Add --apply to convert them.');
  process.exit(0);
}

const { changes } = db
  .prepare(`UPDATE billing_events SET amount_cents = CAST(ROUND(amount_cents * ?) AS INTEGER), currency = 'bdt' WHERE currency = 'usd'`)
  .run(rate);
console.log(`\nConverted ${changes} record(s) to taka at ${rate} taka per dollar.`);
