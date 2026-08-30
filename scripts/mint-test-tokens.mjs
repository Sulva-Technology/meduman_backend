/**
 * LOCAL-ONLY test token minter. Signs HS256 Supabase-style JWTs with the local
 * SUPABASE_JWT_SECRET so you can call the API as each role while running against
 * docker-compose. These are NOT real Supabase tokens — they only verify against
 * the local `secret` strategy (.env / .env.test). Never use in production.
 *
 *   node scripts/mint-test-tokens.mjs
 */
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';

// Load the local env (.env if present, else .env.test) without extra deps.
function loadEnv() {
  for (const file of ['.env', '.env.test']) {
    try {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const out = {};
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      return out;
    } catch {
      /* try next */
    }
  }
  throw new Error('No .env or .env.test found');
}

const env = loadEnv();
const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const issuer = env.SUPABASE_JWT_ISSUER;
const audience = env.SUPABASE_JWT_AUDIENCE || 'authenticated';
const TTL_HOURS = 24 * 7;

// sub ids match prisma/seed.ts so /users/me maps onto the seeded rows.
const ACCOUNTS = [
  { level: 'BUYER', sub: '11111111-1111-1111-1111-111111111111', email: 'buyer@meduman.test', appRole: 'BUYER' },
  { level: 'SELLER', sub: '22222222-2222-2222-2222-222222222222', email: 'seller@meduman.test', appRole: 'SELLER' },
  { level: 'ADMIN', sub: '33333333-3333-3333-3333-333333333333', email: 'super_admin@meduman.test', appRole: 'ADMIN' },
  { level: 'FREELANCER', sub: '44444444-4444-4444-4444-444444444444', email: 'freelancer@meduman.test', appRole: 'FREELANCER' },
  { level: 'BUSINESS', sub: '55555555-5555-5555-5555-555555555555', email: 'business@meduman.test', appRole: 'BUSINESS' },
];

async function mint(a) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: a.email,
    role: 'authenticated',
    app_metadata: { role: a.appRole, provider: 'email' },
    user_metadata: { full_name: `${a.level} Test` },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(a.sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_HOURS * 3600)
    .sign(secret);
}

const results = [];
for (const a of ACCOUNTS) results.push({ ...a, token: await mint(a) });

// Human-readable summary.
console.log('\n=== Meduman local test accounts (valid 7 days) ===\n');
for (const r of results) {
  console.log(`${r.level.padEnd(11)} ${r.email}`);
  console.log(`  sub: ${r.sub}`);
  console.log(`  Authorization: Bearer ${r.token}\n`);
}

// Machine-readable, and shell exports for convenience.
console.log('--- shell exports (source-able) ---');
for (const r of results) console.log(`export TOKEN_${r.level}='${r.token}'`);
