/* Run parseInvoice against real captured pages:
 *   npx tsx scripts/parse-captures.ts ~/Downloads/ynab-amazon-debug.json */
import { readFileSync } from 'node:fs';
import { parseInvoice } from '../lib/amazon';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/parse-captures.ts <debug.json>');
  process.exit(1);
}

const { captures }: { captures: { orderId: string; html: string }[] } =
  JSON.parse(readFileSync(file, 'utf8'));

let failures = 0;
for (const c of captures) {
  const order = parseInvoice(c.html, c.orderId);
  if (order) {
    console.log(
      `ok   ${c.orderId}: ${order.date} $${order.total} — ${order.items
        .map((i) => `${i.name.slice(0, 50)}${i.price !== null ? ` ($${i.price})` : ''}`)
        .join(' | ')}`,
    );
  } else {
    failures++;
    console.error(`FAIL ${c.orderId}: parseInvoice returned null`);
  }
}
process.exit(failures ? 1 : 0);
