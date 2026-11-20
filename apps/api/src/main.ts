import { mkdir } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createApp } from './app.ts';
import { embeddedDatabase, localIdentity, migrate, postgresDatabase, seedLocal } from './database.ts';

const { DATABASE_URL, SUPABASE_URL, EXTENSION_ORIGIN, PORT = '4310' } = process.env;
const localMode = process.argv.includes('--local');
if (!localMode && (!DATABASE_URL || !SUPABASE_URL || !EXTENSION_ORIGIN)) {
  throw new Error('设置 DATABASE_URL、SUPABASE_URL 和 EXTENSION_ORIGIN，或使用 --local 启动单用户开发环境。');
}

if (localMode) await mkdir('.data', { recursive: true });
const db = localMode ? embeddedDatabase('.data/postgres') : postgresDatabase(DATABASE_URL!);
await migrate(db);
if (localMode) await seedLocal(db);
const issuer = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/auth/v1` : undefined;
const jwks = issuer ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) : undefined;
const app = createApp(db, async request => {
  if (localMode) return localIdentity.subject;
  const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || !jwks) return;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    return payload.sub;
  } catch {
    return;
  }
}, localMode ? /^chrome-extension:\/\/[a-p]{32}$/ : EXTENSION_ORIGIN);

app.addHook('onClose', () => db.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
await app.listen({ host: localMode ? '127.0.0.1' : '0.0.0.0', port: Number(PORT) });
