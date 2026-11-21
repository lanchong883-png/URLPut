/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import type { ImportBatch } from '@urlput/contracts';
import type { LedgerRow } from '@urlput/import';

const apiUrl = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const authUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const authKey = import.meta.env.VITE_SUPABASE_PUBLIC_KEY as string | undefined;
export const auth = authUrl && authKey ? createClient(authUrl, authKey, {
  auth: {
    detectSessionInUrl: false,
    storage: {
      async getItem(key) { return (await browser.storage.local.get(key))[key] as string | undefined ?? null; },
      async setItem(key, value) { await browser.storage.local.set({ [key]: value }); },
      async removeItem(key) { await browser.storage.local.remove(key); },
    },
  },
}) : undefined;

export type Batch = {
  id: string;
  source: ImportBatch['source'];
  filename: string | null;
  createdAt: string;
  rows: LedgerRow[];
};
export type BatchSummary = Omit<Batch, 'rows'> & { rowCount: number };

export async function request<T>(path: string, body?: ImportBatch): Promise<T> {
  const { data } = (await auth?.auth.getSession()) ?? {};
  const headers = new Headers();
  if (body) headers.set('Content-Type', 'application/json');
  if (data?.session) headers.set('Authorization', `Bearer ${data.session.access_token}`);
  const response = await fetch(`${apiUrl}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `请求失败（${response.status}）`);
  }
  return response.json();
}

export function requestServiceAccess(baseUrl: string) {
  const url = new URL(baseUrl);
  return browser.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
}

export function requestConfiguredAccess() {
  const origins = [apiUrl, authUrl].filter((value): value is string => Boolean(value)).map(value => {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  });
  return browser.permissions.request({ origins: [...new Set(origins)] });
}
