import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql, type SQL } from 'drizzle-orm';

export interface Database {
  query<Row extends Record<string, unknown>>(statement: SQL): Promise<Row[]>;
  migrate(statement: string): Promise<void>;
  close(): Promise<void>;
}

export const localIdentity = {
  subject: '491effa4-f400-4537-8279-fac44967b824',
  workspace: '44264cea-d845-4e7b-8374-03bb4d679450',
  site: 'ae82c30b-f034-477d-b6b6-f2af84578b35',
};

export function embeddedDatabase(directory?: string): Database {
  const client = new PGlite(directory);
  const db = pgliteDrizzle(client);
  return {
    query: async <Row extends Record<string, unknown>>(statement: SQL) => (await db.execute(statement)).rows as Row[],
    migrate: async statement => { await client.exec(statement); },
    close: () => client.close(),
  };
}

export function postgresDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString });
  const db = pgDrizzle(pool);
  return {
    query: async <Row extends Record<string, unknown>>(statement: SQL) => (await db.execute(statement)).rows as Row[],
    migrate: async statement => { await pool.query(statement); },
    close: () => pool.end(),
  };
}

export async function migrate(db: Database) {
  const initial = await readFile(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
  await db.migrate(initial);
}

export async function seedLocal(db: Database) {
  const { workspace, subject, site } = localIdentity;
  await db.query(sql`INSERT INTO workspaces VALUES (${workspace}, '本地工作空间') ON CONFLICT DO NOTHING`);
  await db.query(sql`INSERT INTO workspace_members VALUES (${workspace}, ${subject}) ON CONFLICT DO NOTHING`);
  await db.query(sql`
    INSERT INTO promotion_sites (id, workspace_id, name, homepage)
    VALUES (${site}, ${workspace}, '示例站点', 'https://example.com') ON CONFLICT DO NOTHING
  `);
}
