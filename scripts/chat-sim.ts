import 'reflect-metadata';
import { resolve } from 'node:path';
import { config } from 'dotenv';

// Load the docker-compose test env BEFORE importing AppModule (its zod schema
// validates the environment at import time). Existing process env wins, so you
// can point DATABASE_URL elsewhere without editing the file.
config({ path: resolve(__dirname, '..', '.env.test') });

import type { BotReply, ChatSimulator } from '../test/utils/chat-simulator';

// ── tiny ANSI helpers ───────────────────────────────────────────────────────
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const SELLER = '555';
const BUYER = '777';
const label = (chatId: string): string => (chatId === SELLER ? 'SELLER' : 'BUYER');

/** Print an inbound line (user → bot). */
function userSays(chatId: string, text: string): void {
  const who = chatId === SELLER ? c.cyan(`${label(chatId)} ▶`) : c.magenta(`${label(chatId)} ▶`);
  console.log(`\n${who} ${c.bold(text)}`);
}

/** Print the bot's captured replies (bot → user), indented. */
function botReplies(replies: BotReply[]): void {
  for (const r of replies) {
    const head = c.green(`  ◀ bot → ${label(r.to)}`);
    const [first, ...rest] = r.text.split('\n');
    console.log(`${head}  ${first ?? ''}`);
    for (const line of rest) console.log(`             ${c.dim(line)}`);
  }
}

function section(title: string): void {
  console.log(`\n${c.yellow('━'.repeat(64))}`);
  console.log(c.yellow(c.bold(`  ${title}`)));
  console.log(c.yellow('━'.repeat(64)));
}

/** Pull the `/pay <code>` link the seller was told to share. */
function extractLinkCode(replies: BotReply[]): string {
  for (const r of replies) {
    const m = r.text.match(/\/pay\s+(\S+)/);
    if (m?.[1]) return m[1];
  }
  throw new Error('No /pay <code> found in the create reply.');
}

/** Read the delivery-confirmation OTP the buyer received in chat. */
function extractOtp(replies: BotReply[]): string {
  for (const r of replies) {
    if (r.to === BUYER && /confirmation code/i.test(r.text)) {
      const m = r.text.match(/(\d{4,10})/);
      if (m?.[1]) return m[1];
    }
  }
  throw new Error('No OTP code found in the buyer’s messages.');
}

async function run(sim: ChatSimulator): Promise<void> {
  await sim.reset();

  section('1 · Seller creates a protected transaction (in chat)');
  userSays(SELLER, '/sell');
  botReplies(await sim.fromUser(SELLER, '/sell', 'Amaka'));
  userSays(SELLER, 'Air Jordans');
  botReplies(await sim.fromUser(SELLER, 'Air Jordans'));
  userSays(SELLER, '5000');
  botReplies(await sim.fromUser(SELLER, '5000'));
  userSays(SELLER, 'Fresh, boxed, size 42');
  const created = await sim.fromUser(SELLER, 'Fresh, boxed, size 42');
  botReplies(created);
  const linkCode = extractLinkCode(created);

  section('2 · Seller sets a payout destination');
  userSays(SELLER, '/setup_payout');
  botReplies(await sim.fromUser(SELLER, '/setup_payout'));
  userSays(SELLER, '058 0123456789');
  botReplies(await sim.fromUser(SELLER, '058 0123456789'));

  section('3 · Buyer opens the pay link → dedicated virtual account');
  userSays(BUYER, `/pay ${linkCode}`);
  botReplies(await sim.fromUser(BUYER, `/pay ${linkCode}`, 'Chidi'));

  // The exact amount to charge lives on the pending DVA payment (server-computed).
  const payment = await sim.prisma.payment.findFirstOrThrow({
    where: { providerCustomerCode: 'CUS_e2e' },
  });

  section('4 · Buyer pays at the bank → signed Paystack charge.success');
  console.log(
    c.dim(
      `  (a chat message can NEVER protect — only this signed webhook can. amount=${payment.amount} kobo)`,
    ),
  );
  botReplies(await sim.paystackChargeSuccess(payment.amount));

  section('5 · Seller delivers → buyer gets a confirmation code in chat');
  userSays(SELLER, '/delivered');
  const delivered = await sim.fromUser(SELLER, '/delivered');
  botReplies(delivered);
  const otp = extractOtp(delivered);

  section('6 · Buyer confirms with the code → funds release');
  userSays(BUYER, otp);
  botReplies(await sim.fromUser(BUYER, otp));

  section('Result');
  const tx = await sim.prisma.transaction.findFirstOrThrow({
    where: { publicLinkId: linkCode },
  });
  const finalPayment = await sim.prisma.payment.findFirstOrThrow({
    where: { transactionId: tx.id },
  });
  console.log(`  transaction status : ${c.bold(tx.status)}`);
  console.log(`  payment status     : ${c.bold(finalPayment.status)}`);
  console.log(
    `  release enqueued   : ${c.bold(sim.releases().includes(tx.id) ? 'YES' : 'NO')} ${c.dim(
      '(the worker would now send the Paystack transfer to the seller)',
    )}`,
  );
  console.log('');
}

async function main(): Promise<void> {
  const { createChatSimulator } = await import('../test/utils/chat-simulator');
  const sim = await createChatSimulator();
  try {
    await run(sim);
  } finally {
    await sim.close();
  }
}

main().catch((err: unknown) => {
  console.error('\nSimulator failed:\n', err);
  process.exit(1);
});
