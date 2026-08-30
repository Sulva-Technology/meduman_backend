/* eslint-disable */
/**
 * Apply migrations to the local docker-compose Postgres using `.env.test`.
 *
 * Prisma only ever reads `.env`, which holds real credentials — so this loads
 * `.env.test` explicitly and shells out. Keeps "migrate the throwaway test DB"
 * one command away from "migrate whatever .env points at".
 */
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
require('dotenv').config({ path: resolve(__dirname, '..', '.env.test') });

if (!process.env.DIRECT_URL) {
  console.error('DIRECT_URL missing — is .env.test present?');
  process.exit(1);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', 'migrate', 'deploy'],
  { stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 1);
