import { boxBottom, row, stack } from '../render.ts';
import type { Board, Box } from '../render.ts';

const signupChain = stack([
  { id: 'signup_form', column: 'sources', y: 0, title: 'someone signs up', lines: ['on the website'], lane: 'web', tags: ['web'] },
  { id: 'signup_event', column: 'adapters', y: 0, title: 'turn it into a send request', lines: ['always sends: a welcome email', '~no template picked yet'], lane: 'web' },
], 80, 26);

const webhookChain = stack([
  { id: 'billing_hook', column: 'adapters', y: 0, title: 'billing calls our webhook', lines: ['one call per paid invoice', '~bad signature → 401, nothing runs'], lane: 'billing', tags: ['billing'] },
  { id: 'retry_queue', column: 'adapters', y: 0, title: 'queue one job per invoice', lines: ['~tries 3 times, 1 min apart'], lane: 'billing' },
  { id: 'billing_event', column: 'adapters', y: 0, title: 'turn it into a send request', lines: ['template = receipt'], lane: 'billing' },
], 260, 26);

const invoiceSource: Box = { id: 'invoice', column: 'sources', y: webhookChain[0].y + 5, title: 'an invoice is paid', lines: ['in the billing tool'], lane: 'billing' };
const invoiceApi: Box = { id: 'invoice_api', column: 'sources', y: webhookChain[2].y, title: 'billing API', lines: ['invoice lines, customer'], kind: 'ext' };

const steps = stack([
  { id: 'log_request', column: 'steps', y: 0, title: '1 log the request', lines: ['~every request, even skipped ones'] },
  { id: 'check_consent', column: 'steps', y: 0, title: '2 check we may email them', lines: ['~unsubscribed → stop here', '~5 emails today already → stop here'] },
  { id: 'render_email', column: 'steps', y: 0, title: '3 fill in the template', lines: ['~missing field → stop here'] },
], 140, 50);

const frame: Box = { id: 'pipeline', column: 'frame', y: 70, title: 'one path for every send', kind: 'frame', height: boxBottom(steps[2]) - 70 + 24 };

const delivery = stack([
  { id: 'provider', column: 'delivery', y: 0, title: 'hand it to the mail provider', lines: ['one send per request, even on retries', '~provider down → retry in 5 min'] },
  { id: 'inbox', column: 'delivery', y: 0, title: 'the email lands in their inbox', kind: 'final' },
], 140, 50);

const ideas = row([
  { id: 'idea_sms', x: 0, width: 160, y: 700, height: 44, title: 'SMS reminders', kind: 'ghost' },
  { id: 'idea_digest', x: 0, width: 160, y: 700, height: 44, title: 'weekly digest', kind: 'ghost' },
], 20, 12);

const board: Board = {
  title: 'Example: how a signup or a paid invoice becomes an email',
  subtitleHtml: 'Sample board for the drawing-whiteboards skill.',
  captionHtml: 'Both sources turn into the same send request. Blue = website, orange = billing, dashed grey = an idea, not built.',
  ariaLabel: 'A signup and a paid invoice each become a send request; one pipeline logs it, checks consent, fills the template, and hands it to the mail provider.',
  width: 1300,
  height: 770,
  columns: {
    sources: { x: 20, width: 200 },
    adapters: { x: 280, width: 300 },
    frame: { x: 640, width: 330 },
    steps: { x: 665, width: 280 },
    delivery: { x: 1020, width: 260 },
  },
  lanes: { web: { color: '#2563eb', tag: 'web' }, billing: { color: '#c2410c', tag: 'bill' } },
  headings: [
    { x: 20, y: 40, text: 'SOURCES' },
    { x: 280, y: 40, text: 'ADAPTERS · plain code' },
    { x: 1020, y: 40, text: 'DELIVERY' },
    { x: 20, y: 688, text: 'IDEAS, NOT BUILT' },
  ],
  boxes: [frame, ...signupChain, ...webhookChain, invoiceSource, invoiceApi, ...steps, ...delivery, ...ideas],
  buses: [{ id: 'requests', to: 'log_request', channel: 612 }],
  edges: [
    { from: 'signup_form', to: 'signup_event' },
    { from: 'invoice', to: 'billing_hook' },
    { from: 'billing_hook', to: 'retry_queue', fromSide: 'bottom', toSide: 'top' },
    { from: 'retry_queue', to: 'billing_event', fromSide: 'bottom', toSide: 'top' },
    { from: 'invoice_api', to: 'billing_event', style: 'dashed' },
    { from: 'signup_event', bus: 'requests' },
    { from: 'billing_event', bus: 'requests' },
    { from: 'retry_queue', bus: 'requests', style: 'fail', label: 'job fails → logged' },
    { from: 'log_request', to: 'check_consent', fromSide: 'bottom', toSide: 'top' },
    { from: 'check_consent', to: 'render_email', fromSide: 'bottom', toSide: 'top' },
    { from: 'render_email', to: 'provider', channel: 995, label: 'send it' },
    { from: 'provider', to: 'inbox', fromSide: 'bottom', toSide: 'top', label: 'delivered' },
  ],
  notes: [
    { title: 'Why one pipeline', itemsHtml: ['Consent and the daily cap live in one place, so a new source cannot skip them.'] },
  ],
};

export default board;
