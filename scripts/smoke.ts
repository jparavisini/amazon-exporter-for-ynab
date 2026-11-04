/* Smoke test: run with `npm run smoke`. Exercises the transactions-page
 * parser, the invoice parser, and the matcher against synthetic fixtures
 * shaped like Amazon's markup. */
import { load } from 'cheerio/slim';
import {
  buildNextPageBody,
  parseInvoice,
  parseTransactionsPage,
} from '../lib/amazon';
import {
  buildMemo,
  buildRefundMemo,
  buildSplits,
  findOriginalTransaction,
  matchCharges,
  matchRefunds,
} from '../lib/matcher';
import type { AmazonCharge, AmazonOrder } from '../lib/amazon';
import type { YnabTransaction } from '../lib/ynab';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`, detail ?? '');
  }
}

// --- parseTransactionsPage ---

const transactionsHtml = `
<html><body>
<form method="post" action="/cpe/yourpayments/transactions">
  <input type="hidden" name="ppw-widgetState" value="STATE_TOKEN_123" />
  <input type="hidden" name="ie" value="UTF-8" />
  <div class="apx-transaction-date-container"><span>June 28, 2026</span></div>
  <div class="apx-transactions-line-item-component-container">
    <div class="a-row"><span class="a-size-base-plus a-text-bold">Prime Visa ****1234</span>
      <span class="a-size-base-plus a-text-bold">-$70.32</span></div>
    <div class="a-row"><a class="a-link-normal" href="/gp/css/summary/edit.html?orderID=113-1111111-1111111">Order #113-1111111-1111111</a></div>
  </div>
  <div class="apx-transactions-line-item-component-container">
    <div class="a-row"><span>Prime Visa ****1234</span><span>-$27.39</span></div>
    <div class="a-row"><a href="#">Order #113-2222222-2222222</a></div>
  </div>
  <div class="apx-transaction-date-container"><span>June 25, 2026</span></div>
  <div class="apx-transactions-line-item-component-container">
    <div class="a-row"><span>Prime Visa ****1234</span><span>$12.50</span></div>
    <div class="a-row"><a href="#">Order #113-3333333-3333333</a></div>
  </div>
  <span class="a-button a-button-span12">
    <input class="a-button-input" type="submit"
      name="ppw-widgetEvent:DefaultNextPageNavigationEvent:{&quot;nextPageKey&quot;:&quot;abc&quot;}" value="" />
  </span>
</form>
</body></html>`;

const $txn = load(transactionsHtml);
const page = parseTransactionsPage($txn);
check('two charges parsed', page.charges.length === 2, page.charges);
check('one credit parsed', page.credits.length === 1, page.credits);
check(
  'credit fields',
  page.credits[0]?.orderId === '113-3333333-3333333' &&
    page.credits[0]?.date === '2026-06-25' &&
    page.credits[0]?.amount === 12.5,
  page.credits[0],
);
check(
  'charge fields',
  page.charges[0]?.orderId === '113-1111111-1111111' &&
    page.charges[0]?.date === '2026-06-28' &&
    page.charges[0]?.amount === 70.32,
  page.charges[0],
);
check(
  'payment method',
  page.charges[0]?.paymentMethod.includes('1234'),
  page.charges[0]?.paymentMethod,
);
check(
  'date groups apply in order',
  page.charges[1]?.date === '2026-06-28',
  page.charges[1],
);

const nextBody = buildNextPageBody($txn);
check('next page body built', nextBody !== null);
check(
  'next page body has widget state and event',
  (nextBody ?? '').includes('ppw-widgetState=STATE_TOKEN_123') &&
    (nextBody ?? '').includes('DefaultNextPageNavigationEvent'),
  nextBody,
);

const lastPage$ = load('<html><body><form></form></body></html>');
check('no next page on last page', buildNextPageBody(lastPage$) === null);

// --- parseInvoice: legacy print page ---

const invoiceHtml = `
<html><body>
  <b>Order Placed:</b> June 12, 2026<br/>
  <b>Amazon.com order number:</b> 112-1234567-7654321
  <table>
    <tr><td><b>Items Ordered</b></td><td>Price</td></tr>
    <tr><td><i>Echo Dot (5th Gen) Smart Speaker</i><br/>Sold by Amazon.com</td><td>$49.99</td></tr>
    <tr><td><i>Anker USB-C Cable 6ft (2-pack)</i></td><td>$12.99</td></tr>
  </table>
  <table>
    <tr><td>Item(s) Subtotal:</td><td>$62.98</td></tr>
    <tr><td><b>Grand Total:</b></td><td><b>$67.39</b></td></tr>
  </table>
</body></html>`;

const order = parseInvoice(invoiceHtml, '112-1234567-7654321');
check('legacy invoice parses', order !== null);
check('legacy date', order?.date === '2026-06-12', order?.date);
check('legacy total', order?.total === 67.39, order?.total);
check('legacy items', order?.items.length === 2, order?.items);
check(
  'legacy item prices',
  order?.items[0]?.price === 49.99 && order?.items[1]?.price === 12.99,
  order?.items,
);

// --- parseInvoice: modern data-component page (captured July 2026) ---

const modernHtml = `
<html><body>
  <div class="" data-component="orderDateLabel"><span>Order placed</span></div>
  <div class="" data-component="orderDate">
    <span>June 28, 2026 <i class="a-icon a-icon-text-separator" role="presentation"></i></span>
  </div>
  <div class="" data-component="itemTitle">
    <div class="a-row"><a class="a-link-normal" href="/dp/B09XN6MQWP?ref_=x">15 Pack 5 Gallon Mylar Bags with Oxygen Absorbers</a></div>
  </div>
  <div class="" data-component="chargeSummary">
    <div class="a-row od-line-item-row">
      <span class="a-text-bold"><span>Grand Total:</span></span>
      <span class="a-text-bold">
        $28.98
      </span>
    </div>
  </div>
</body></html>`;

const modern = parseInvoice(modernHtml, '113-5256529-7477024');
check('modern invoice parses', modern !== null);
check('modern date', modern?.date === '2026-06-28', modern?.date);
check('modern total', modern?.total === 28.98, modern?.total);
check(
  'modern item',
  modern?.items[0]?.name === '15 Pack 5 Gallon Mylar Bags with Oxygen Absorbers',
  modern?.items,
);

// --- parseInvoice: Fresh / Whole Foods print page (captured November 2026) ---

const freshRow = (asin: string, name: string, cells: string[]) => `
  <div id="${asin}-item-grid-row" class="a-row" role="row">
    <div class="a-column a-span1" role="gridcell"><img alt="${name}"/></div>
    <div class="a-column a-span11" role="presentation">
      <div class="a-column a-span6" role="gridcell">
        <a class="a-link-normal" href="/gp/product/${asin}?ref_=uff_od_product"><span>${name}</span></a>
      </div>
      ${cells.map((c) => `<div class="a-column" role="gridcell">${c}</div>`).join('')}
    </div>
  </div>
  <hr id="${asin}-item-grid-divider"/>`;

const freshHtml = `
<html><body>
  <span>Order #: 114-0000000-0000001</span><br/>
  <span>
    Ordered October 31, 2026 12:27PM
  </span>
  <a href="/gp/product/B000NAV000">Recommended for you</a>
  ${freshRow('B0787Y4X59', 'Bell &amp; Evans Chicken Breast Value Pack', [
    '3',
    '13.10 lb <span>($5.99/lb)</span>',
    '$78.47',
    '',
    'Weight adjusted from est. 11.49 lb',
  ])}
  ${freshRow('B00QKXNH2Y', 'Traditional Lavash 5 Count', ['1', '', '$5.29'])}
  <dl>
    <dt>Item(s) Subtotal:</dt><dd>$83.76</dd>
    <dt>Driver tip:</dt><dd>$7.00</dd>
    <dt><span class="a-text-bold">Grand Total:</span></dt>
    <dd><span class="a-text-bold">
      $90.76
    </span></dd>
  </dl>
</body></html>`;

const fresh = parseInvoice(freshHtml, '114-0000000-0000001');
check('fresh invoice parses', fresh !== null);
check('fresh date', fresh?.date === '2026-10-31', fresh?.date);
check('fresh total includes the tip', fresh?.total === 90.76, fresh?.total);
check(
  'fresh items skip links outside the item grid',
  fresh?.items.map((i) => i.name).join(' | ') ===
    'Bell & Evans Chicken Breast Value Pack | Traditional Lavash 5 Count',
  fresh?.items,
);
check(
  'fresh weighed item takes the line total, not the per-pound price',
  fresh?.items[0]?.price === 78.47 && fresh?.items[1]?.price === 5.29,
  fresh?.items,
);
check(
  'fresh charge without the tip stays memo-only',
  fresh !== null && buildSplits(fresh, 83.76) === null,
);

const garbage = parseInvoice('<html><body><h2>We\'re sorry!</h2></body></html>', 'x');
check('unparseable invoice returns null', garbage === null);

// --- matchCharges ---

const txn = (
  id: string,
  date: string,
  amount: number,
  payee: string,
  memo: string | null = null,
  category: string | null = null,
): YnabTransaction => ({
  id,
  date,
  amount,
  payee_name: payee,
  memo,
  cleared: 'cleared',
  approved: true,
  category_name: category,
});

const charge = (
  orderId: string,
  date: string,
  amount: number,
): AmazonCharge => ({ orderId, date, amount, paymentMethod: 'Visa ****1234' });

const charges = [
  charge('A', '2026-06-12', 67.39),
  charge('B', '2026-06-15', 23.5),
  charge('C', '2026-06-20', 99.99),
  // split shipment: same order, two charges
  charge('D', '2026-06-22', 10.0),
  charge('D', '2026-06-23', 15.0),
];

const txns: YnabTransaction[] = [
  txn('t1', '2026-06-13', -67390, 'Amazon.com'),
  txn('t2', '2026-06-16', -23500, 'AMZN Mktp US'),
  txn('t3', '2026-06-21', -99990, 'Costco'), // wrong payee
  txn('t4', '2026-06-14', -67390, 'Amazon.com', 'already has memo'),
  txn('t5', '2026-06-23', -10000, 'Amazon.com'),
  txn('t6', '2026-06-24', -15000, 'Amazon.com'),
];

const matches = matchCharges(charges, txns);
check('four matches', matches.length === 4, matches.map((m) => m.charge.orderId));
check(
  'A matched to t1',
  matches.some((m) => m.charge.orderId === 'A' && m.txn.id === 't1'),
);
check(
  'C unmatched (payee filter)',
  !matches.some((m) => m.charge.orderId === 'C'),
);
check(
  'split shipment: both D charges matched',
  matches.filter((m) => m.charge.orderId === 'D').length === 2,
);

// one txn never claimed twice
const dupCharges = [charge('X', '2026-06-12', 10), charge('Y', '2026-06-12', 10)];
const oneTxn = [txn('t9', '2026-06-13', -10000, 'Amazon.com')];
check('one-to-one claiming', matchCharges(dupCharges, oneTxn).length === 1);

const longMemo = buildMemo(
  Array.from({ length: 60 }, (_, i) => `Item number ${i} with a long name`),
  '111-1234567-7654321',
);
check('memo truncated', longMemo.length <= 480, longMemo.length);
check(
  'order id survives truncation',
  longMemo.endsWith(' [111-1234567-7654321]'),
  longMemo.slice(-30),
);
check(
  'short memo has order id',
  buildMemo(['Echo Dot'], '111-0000000-0000000') ===
    'Echo Dot [111-0000000-0000000]',
);

// --- refunds ---

const refundOrder: AmazonOrder = {
  id: '111-5555555-5555555',
  date: '2026-06-10',
  total: 67.39,
  items: [
    { name: 'Echo Dot (5th Gen) Smart Speaker', price: 49.99 },
    { name: 'Anker USB-C Cable 6ft (2-pack)', price: 12.99 },
  ],
};

const refundTxns = [
  txn('r1', '2026-06-26', 53740, 'Amazon.com'),
  txn('r2', '2026-06-26', -53740, 'Amazon.com'), // outflow, must not match
];
const refundMatches = matchRefunds(
  [
    { orderId: refundOrder.id, date: '2026-06-25', amount: 53.74, paymentMethod: '' },
  ],
  refundTxns,
);
check(
  'refund matched to inflow',
  refundMatches.length === 1 && refundMatches[0].txn.id === 'r1',
  refundMatches,
);

const fullRefund = buildRefundMemo(refundOrder, 67.39, 'Electronics');
check(
  'full refund memo lists items and category',
  fullRefund ===
    'Refund: Echo Dot (5th Gen) Smart Speaker, Anker USB-C Cable 6ft (2-pack) → was: Electronics [111-5555555-5555555]',
  fullRefund,
);

const itemRefund = buildRefundMemo(refundOrder, 53.74, null);
check(
  'partial refund names the single price-matched item',
  itemRefund === 'Refund: Echo Dot (5th Gen) Smart Speaker [111-5555555-5555555]',
  itemRefund,
);

const ambiguousRefund = buildRefundMemo(refundOrder, 30.0, null);
check(
  'ambiguous partial refund falls back to item list',
  ambiguousRefund.startsWith('Partial refund of $67.39 order:') &&
    ambiguousRefund.includes('Echo Dot'),
  ambiguousRefund,
);

// --- findOriginalTransaction ---

const originalTxns = [
  txn('o1', '2026-06-11', -67390, 'Amazon.com', 'stuff [111-5555555-5555555]', 'Electronics'),
  txn('o2', '2026-06-11', -67390, 'Amazon.com', null, 'Household'),
];
check(
  'original found by order id in memo',
  findOriginalTransaction(refundOrder, originalTxns)?.id === 'o1',
);
check(
  'original found by amount when no memo has the order id',
  findOriginalTransaction(refundOrder, [originalTxns[1]])?.id === 'o2',
);
check(
  'no original when nothing matches',
  findOriginalTransaction(refundOrder, [
    txn('o3', '2026-06-11', -10000, 'Amazon.com'),
  ]) === null,
);

// --- buildSplits ---

const splits = buildSplits(refundOrder, 67.39);
check(
  'splits: item amounts plus tax remainder',
  splits?.length === 3 &&
    splits[0].amount === -49990 &&
    splits[1].amount === -12990 &&
    splits[2].amount === -4410 &&
    splits[2].memo === 'Tax & shipping',
  splits,
);
check(
  'splits sum to the charge',
  splits?.reduce((s, x) => s + x.amount, 0) === -67390,
);
check('no splits for single item', buildSplits({ ...refundOrder, items: [refundOrder.items[0]] }, 67.39) === null);
check('no splits when charge is not the order total', buildSplits(refundOrder, 49.99) === null);
check(
  'no splits when a price is missing',
  buildSplits(
    { ...refundOrder, items: [refundOrder.items[0], { name: 'X mystery item', price: null }] },
    67.39,
  ) === null,
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
