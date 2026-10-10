import { load, type CheerioAPI } from 'cheerio/slim';

const TRANSACTIONS_URL = 'https://www.amazon.com/cpe/yourpayments/transactions';
const ORDER_DETAILS_URL = 'https://www.amazon.com/gp/css/summary/print.html';
const FETCH_TIMEOUT_MS = 10_000;
const DETAIL_CONCURRENCY = 4;
const MAX_TRANSACTION_PAGES = 25;

export const AMAZON_ORIGINS = [
  'https://www.amazon.com/*',
  'https://amazon.com/*',
];
export const AMAZON_LOGIN_URL = 'https://www.amazon.com/orders';

export class AmazonSessionError extends Error {}

/** A card charge from the Your Payments → Transactions page. One order can
 * produce several charges (split shipments); amounts are what actually hit
 * the card. */
export interface AmazonCharge {
  orderId: string;
  /** ISO date (YYYY-MM-DD) the charge posted */
  date: string;
  /** Dollars, positive = money out */
  amount: number;
  paymentMethod: string;
}

export interface AmazonItem {
  name: string;
  /** Item price in dollars when the invoice shows one */
  price: number | null;
}

export interface AmazonOrder {
  id: string;
  date: string;
  total: number;
  items: AmazonItem[];
}

export interface ScanCounts {
  /** Card charges found on the transactions page */
  charges: number;
  /** Refund credits found on the transactions page */
  credits: number;
  /** Matched charges dropped because the order is digital */
  digitalSkipped: number;
  /** Matched charges dropped because the invoice could not be parsed */
  invoicesUnparsed: number;
}

/** Raw evidence of a page that could not be parsed, for debugging. */
export interface DebugCapture {
  orderId: string;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  html: string;
}

interface FetchedPage {
  text: string;
  finalUrl: string;
  status: number;
}

async function fetchPage(url: string, init?: RequestInit): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new AmazonSessionError('Amazon session expired');
    }
    if (res.status !== 200) {
      throw new Error(`Amazon returned status ${res.status}`);
    }
    return { text: await res.text(), finalUrl: res.url, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function validateSession($: CheerioAPI): void {
  if ($('h1:contains("Sign in")').length > 0) {
    throw new AmazonSessionError('Sign in to Amazon required');
  }
}

const LONG_DATE_PATTERN = /([A-Za-z]+ \d{1,2}, \d{4})/;

function toIsoDate(longDate: string): string | null {
  const parsed = new Date(`${longDate} 12:00:00 UTC`);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

// --- Transactions page ---

/** Amazon serves two Transactions pages, chosen per account. The classic one
 * renders rows as markup; the redesigned one embeds them as JSON in
 * __NEXT_DATA__ and pages client-side, so only its first page is readable. */
export function parseTransactionsPage($: CheerioAPI): {
  charges: AmazonCharge[];
  credits: AmazonCharge[];
} {
  return $('.apx-transactions-line-item-component-container').length > 0
    ? parseTransactionsMarkup($)
    : parseTransactionsJson($('script#__NEXT_DATA__').first().text() || '{}');
}

interface TransactionJson {
  formattedAmount?: string;
  formattedDate?: string;
  orderData?: { orderDisplayString?: string }[];
  statusInfo?: { amountDetailsStatusType?: string };
  paymentMethodDisplayStringData?: {
    paymentMethodName?: string;
    paymentMethodNumber?: { lastDigits?: string };
  };
}

function parseTransactionsJson(nextData: string): {
  charges: AmazonCharge[];
  credits: AmazonCharge[];
} {
  const charges: AmazonCharge[] = [];
  const credits: AmazonCharge[] = [];
  const list: TransactionJson[] =
    JSON.parse(nextData)?.props?.pageProps?.state?.transactionResponseState
      ?.visibleTransactionResponse?.transactionList ?? [];
  for (const t of list) {
    const amount = t.formattedAmount?.match(/\$([\d,]+\.\d{2})/)?.[1];
    const dateText = t.formattedDate?.match(LONG_DATE_PATTERN)?.[1];
    const date = dateText ? toIsoDate(dateText) : null;
    const orderId = t.orderData?.[0]?.orderDisplayString?.match(
      /((?:D\d{2}|\d{3})-\d{7}-\d{7})/,
    )?.[1];
    if (!amount || !date || !orderId) continue;
    const card = t.paymentMethodDisplayStringData;
    const digits = card?.paymentMethodNumber?.lastDigits;
    (t.statusInfo?.amountDetailsStatusType === 'Refund' ? credits : charges).push({
      orderId,
      date,
      amount: parseFloat(amount.replace(/,/g, '')),
      paymentMethod: digits ? `${card?.paymentMethodName ?? 'Card'} ****${digits}` : '',
    });
  }
  return { charges, credits };
}

function parseTransactionsMarkup($: CheerioAPI): {
  charges: AmazonCharge[];
  credits: AmazonCharge[];
} {
  const charges: AmazonCharge[] = [];
  const credits: AmazonCharge[] = [];
  let currentDate: string | null = null;

  $(
    '.apx-transaction-date-container, .apx-transactions-line-item-component-container',
  ).each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('apx-transaction-date-container')) {
      const m = $el.text().match(LONG_DATE_PATTERN);
      if (m) currentDate = toIsoDate(m[1]) ?? currentDate;
      return;
    }

    const text = $el.text().replace(/\s+/g, ' ');
    const amountMatch = text.match(/(-?)\s*\$([\d,]+\.\d{2})/);
    // Amazon order IDs are 3-7-7 digit groups ("D01-…" for digital orders).
    const orderId =
      text.match(/Order\s+#\s*((?:D\d{2}|\d{3})-\d{7}-\d{7})/i)?.[1] ??
      $el
        .find('a[href*="orderID="]')
        .attr('href')
        ?.match(/orderID=((?:D\d{2}|\d{3})-\d{7}-\d{7})/)?.[1];
    if (!currentDate || !amountMatch || !orderId) return;
    (amountMatch[1] === '-' ? charges : credits).push({
      orderId,
      date: currentDate,
      amount: parseFloat(amountMatch[2].replace(/,/g, '')),
      paymentMethod: text.match(/([A-Za-z][A-Za-z ]*\*{3,4}\s?\d{4})/)?.[1] ?? '',
    });
  });

  return { charges, credits };
}

/** Serialize the widget form that drives the transaction page's "Next page"
 * button into a POST body. Returns null on the last page. */
export function buildNextPageBody($: CheerioAPI): string | null {
  const eventInput = $(
    'input[name^="ppw-widgetEvent:DefaultNextPageNavigationEvent"]',
  ).first();
  if (eventInput.length === 0) return null;
  const form = eventInput.closest('form');
  if (form.length === 0) return null;

  const params = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) params.append(name, $(el).attr('value') ?? '');
  });
  params.append(eventInput.attr('name')!, eventInput.attr('value') ?? '');
  return params.toString();
}

export interface FetchChargesOptions {
  /** Stop paginating once charges are older than this ISO date */
  sinceDate: string;
  /** Only keep charges on or before this ISO date */
  untilDate?: string;
  limit: number;
  onProgress?: (message: string) => void;
}

export async function fetchAmazonCharges({
  sinceDate,
  untilDate,
  limit,
  onProgress,
}: FetchChargesOptions): Promise<{
  charges: AmazonCharge[];
  credits: AmazonCharge[];
  captures: DebugCapture[];
}> {
  const all: AmazonCharge[] = [];
  const allCredits: AmazonCharge[] = [];
  const captures: DebugCapture[] = [];
  let postBody: string | null = null;

  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page++) {
    onProgress?.(`Fetching Amazon transactions page ${page}…`);
    const fetched = await fetchPage(
      TRANSACTIONS_URL,
      postBody === null
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: postBody,
          },
    );
    const $ = load(fetched.text);
    validateSession($);

    const parsed = parseTransactionsPage($);
    if (parsed.charges.length === 0 && parsed.credits.length === 0 && page === 1) {
      captures.push({
        orderId: '(transactions page)',
        requestedUrl: TRANSACTIONS_URL,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        html: fetched.text.slice(0, 500_000),
      });
      break;
    }
    all.push(...parsed.charges);
    allCredits.push(...parsed.credits);

    const pastCutoff = [...parsed.charges, ...parsed.credits].some(
      (c) => c.date < sinceDate,
    );
    if (pastCutoff || all.length >= limit) break;
    postBody = buildNextPageBody($);
    if (!postBody) break;
  }

  const inWindow = (c: AmazonCharge) =>
    c.date >= sinceDate && (!untilDate || c.date <= untilDate);
  const charges = all.filter(inWindow).slice(0, limit);
  const credits = allCredits.filter(inWindow);
  return { charges, credits, captures };
}

// --- Order invoice (item names for the memo) ---

/** Parse the invoice / Order Details page into a structured order. Handles
 * both the modern data-component page and the legacy print invoice. Returns
 * null when any required field can't be confidently extracted. */
export function parseInvoice(html: string, orderId: string): AmazonOrder | null {
  const $ = load(html);
  const text = $('body').text().replace(/\s+/g, ' ');

  let dateText = $('[data-component="orderDate"]')
    .first()
    .text()
    .match(LONG_DATE_PATTERN)?.[1];
  if (!dateText) {
    dateText = text.match(
      new RegExp(`Order [Pp]laced:?\\s*${LONG_DATE_PATTERN.source}`),
    )?.[1];
  }
  if (!dateText) return null;
  const date = toIsoDate(dateText);
  if (!date) return null;

  const totalMatch = text.match(/Grand Total:\s*\$([\d,]+\.\d{2})/);
  if (!totalMatch) return null;
  const total = parseFloat(totalMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(total) || total < 0) return null;

  const items: AmazonItem[] = [];
  const seen = new Set<string>();
  const pushItem = (raw: string, price: number | null = null) => {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name.length > 2 && !seen.has(name)) {
      seen.add(name);
      items.push({ name, price });
    }
  };
  const parsePrice = (raw: string): number | null => {
    const m = raw.match(/\$([\d,]+\.\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };
  // Modern page: one data-component="itemTitle" per line item; unitPrice
  // components pair up by index when both lists are the same length.
  const titles = $('[data-component="itemTitle"]');
  const prices = $('[data-component="unitPrice"]');
  titles.each((i, el) =>
    pushItem(
      $(el).text(),
      titles.length === prices.length ? parsePrice($(prices[i]).text()) : null,
    ),
  );
  // Legacy print page: italicized titles in the Items Ordered table, price in
  // the row's last cell.
  if (items.length === 0) {
    $('td i').each((_, el) =>
      pushItem(
        $(el).text(),
        parsePrice($(el).closest('tr').find('td').last().text()),
      ),
    );
  }
  if (items.length === 0) {
    $('a[href*="/gp/product/"], a[href*="/dp/"]').each((_, el) =>
      pushItem($(el).text()),
    );
  }
  if (items.length === 0) return null;

  return { id: orderId, date, total, items };
}

async function fetchInvoice(
  orderId: string,
): Promise<{ order: AmazonOrder | null; capture: DebugCapture | null }> {
  const requestedUrl = `${ORDER_DETAILS_URL}?orderID=${orderId}`;
  const page = await fetchPage(requestedUrl);
  const $ = load(page.text);
  const order =
    $('h2:contains("We\'re sorry!")').length > 0
      ? null
      : parseInvoice(page.text, orderId);
  const capture: DebugCapture | null = order
    ? null
    : {
        orderId,
        requestedUrl,
        finalUrl: page.finalUrl,
        status: page.status,
        html: page.text.slice(0, 500_000),
      };
  return { order, capture };
}

async function mapWithConcurrency<T, R>(
  inputs: T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, inputs.length) },
    async () => {
      while (next < inputs.length) {
        const i = next++;
        results[i] = await fn(inputs[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Fetch and parse invoices for the given order IDs. Returns a map of
 * orderId → order (absent when unparseable) plus debug captures for
 * failures. */
export async function fetchOrderDetails(
  orderIds: string[],
  onProgress?: (message: string) => void,
): Promise<{ orders: Map<string, AmazonOrder>; captures: DebugCapture[] }> {
  const unique = [...new Set(orderIds)];
  onProgress?.(`Fetching ${unique.length} order invoices…`);
  const results = await mapWithConcurrency(unique, DETAIL_CONCURRENCY, (id) =>
    fetchInvoice(id).catch(() => ({ order: null, capture: null })),
  );
  const orders = new Map<string, AmazonOrder>();
  const captures: DebugCapture[] = [];
  for (const r of results) {
    if (r.order) orders.set(r.order.id, r.order);
    else if (r.capture) captures.push(r.capture);
  }
  return { orders, captures };
}
