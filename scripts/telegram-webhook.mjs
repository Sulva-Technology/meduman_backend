#!/usr/bin/env node
// Register / inspect / remove the Telegram webhook for the chat bot.
//
//   node scripts/telegram-webhook.mjs set      # point Telegram at your API
//   node scripts/telegram-webhook.mjs info      # show current webhook status
//   node scripts/telegram-webhook.mjs delete    # unregister
//
// Reads from the environment (or a .env file if you export it first):
//   TELEGRAM_BOT_TOKEN       required — from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  required for `set` — must equal the running app's
//   APP_URL                  required for `set` — public https base url
//
// The `secret_token` we register MUST equal TELEGRAM_WEBHOOK_SECRET, because the
// adapter rejects any update whose X-Telegram-Bot-Api-Secret-Token header does
// not match. Telegram only delivers webhooks to https URLs.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(method, params) {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error(`Telegram ${method} failed:`, json.description ?? res.status);
    process.exit(1);
  }
  return json.result;
}

const command = process.argv[2] ?? 'info';

switch (command) {
  case 'set': {
    const appUrl = process.env.APP_URL;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!appUrl || !secret) {
      console.error('APP_URL and TELEGRAM_WEBHOOK_SECRET must both be set for `set`.');
      process.exit(1);
    }
    if (!appUrl.startsWith('https://')) {
      console.error(`APP_URL must be https (Telegram requirement): got ${appUrl}`);
      process.exit(1);
    }
    const url = `${appUrl.replace(/\/$/, '')}/chat/telegram/webhook`;
    await call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`Webhook set -> ${url}`);
    break;
  }
  case 'info': {
    const info = await call('getWebhookInfo');
    console.log(JSON.stringify(info, null, 2));
    break;
  }
  case 'delete': {
    await call('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook deleted.');
    break;
  }
  default:
    console.error(`Unknown command "${command}". Use: set | info | delete`);
    process.exit(1);
}
