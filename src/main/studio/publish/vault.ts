// Keeps your upload accounts (developer app keys and sign-in tokens) on this PC only,
// encrypted with Windows' own user encryption (Electron safeStorage / DPAPI).

import fs from 'node:fs';
import path from 'node:path';
import type { PublishPlatform } from '../../../shared/studio';

export interface Tokens {
  access: string;
  refresh?: string;
  /** Epoch ms. */
  expiresAt?: number;
  refreshExpiresAt?: number;
  scope?: string;
}

export interface Account {
  clientId?: string;
  clientSecret?: string;
  tokens?: Tokens;
  account?: string;
  /** Instagram business account id. */
  igUserId?: string;
  tiktokMode?: 'inbox' | 'direct';
}

export interface Crypto {
  available(): boolean;
  encrypt(s: string): Buffer;
  decrypt(b: Buffer): string;
}

export class Vault {
  private data: Partial<Record<PublishPlatform, Account>> | undefined;

  constructor(
    private file: string,
    private crypto: Crypto,
  ) {}

  private load(): Partial<Record<PublishPlatform, Account>> {
    if (this.data) return this.data;
    this.data = {};
    try {
      if (fs.existsSync(this.file) && this.crypto.available()) this.data = JSON.parse(this.crypto.decrypt(fs.readFileSync(this.file)));
    } catch {
      this.data = {};
    }
    return this.data!;
  }

  get(p: PublishPlatform): Account {
    return { ...(this.load()[p] ?? {}) };
  }

  set(p: PublishPlatform, patch: Partial<Account>): Account {
    const all = this.load();
    const next: Account = { ...(all[p] ?? {}), ...patch };
    for (const k of Object.keys(next) as (keyof Account)[]) if (next[k] === undefined) delete next[k];
    all[p] = next;
    this.persist();
    return { ...next };
  }

  clear(p: PublishPlatform, keepKeys = true): void {
    const all = this.load();
    const cur = all[p] ?? {};
    all[p] = keepKeys ? { clientId: cur.clientId, clientSecret: cur.clientSecret, tiktokMode: cur.tiktokMode } : {};
    this.persist();
  }

  private persist() {
    // Without OS encryption, keep accounts for this session only rather than writing secrets in the clear.
    if (!this.crypto.available()) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.crypto.encrypt(JSON.stringify(this.data ?? {})));
  }
}
