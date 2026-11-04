// Uploading finished reels to YouTube, TikTok and Instagram.
// Each platform needs a free developer app of your own (keys stay on this PC, encrypted).
// Without one, the Studio still helps: it opens the platform's upload page, shows the file and copies the caption.

import fs from 'node:fs';
import type { PublishPlatform, PublishProgress, PublishRequest, PublishStatus } from '../../../shared/studio';
import * as instagram from './instagram';
import * as tiktok from './tiktok';
import type { Vault } from './vault';
import * as youtube from './youtube';

export interface PublishDeps {
  vault: Vault;
  openBrowser: (url: string) => void;
  /** Opens a sign-in window and resolves with the address it ends on (for Facebook's desktop login). */
  loginWindow: (url: string, isDone: (url: string) => boolean) => Promise<string>;
  fetchFn?: typeof fetch;
}

export const PLATFORMS: PublishPlatform[] = ['youtube', 'tiktok', 'instagram'];

export class PublishService {
  constructor(private d: PublishDeps) {}

  private get fetch() {
    return this.d.fetchFn ?? fetch;
  }

  status(): PublishStatus[] {
    return PLATFORMS.map((p) => {
      const a = this.d.vault.get(p);
      const configured = !!(a.clientId && a.clientSecret);
      const connected = configured && !!a.tokens && (!a.tokens.refreshExpiresAt || a.tokens.refreshExpiresAt > Date.now()) && (p !== 'instagram' || !a.tokens.expiresAt || a.tokens.expiresAt > Date.now());
      const base = { platform: p, configured, connected, account: connected ? a.account : undefined };
      if (p === 'youtube')
        return {
          ...base,
          label: 'YouTube',
          note: 'Uploads videos and Shorts straight to your channel. Your Google project has a daily upload limit, which is plenty for a few reels a day.',
          setupUrl: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
          uploadPageUrl: 'https://studio.youtube.com/',
          fields: [
            { key: 'clientId', label: 'OAuth client ID (Desktop app)' },
            { key: 'clientSecret', label: 'Client secret' },
          ],
        };
      if (p === 'tiktok')
        return {
          ...base,
          label: 'TikTok',
          tiktokMode: a.tiktokMode ?? 'inbox',
          note:
            (a.tiktokMode ?? 'inbox') === 'inbox'
              ? 'Sends the video to your TikTok inbox as a draft. Open TikTok to add a trending sound and post it, which also keeps full reach.'
              : 'Posts straight to your profile. TikTok keeps these private until your developer app passes their audit.',
          setupUrl: 'https://developers.tiktok.com/apps/',
          uploadPageUrl: 'https://www.tiktok.com/tiktokstudio/upload',
          fields: [
            { key: 'clientId', label: 'Client key' },
            { key: 'clientSecret', label: 'Client secret' },
          ],
          redirectUri: 'http://127.0.0.1:*/callback/',
        };
      return {
        ...base,
        label: 'Instagram',
        note: 'Posts a Reel to your Instagram professional (Creator or Business) account. It must be linked to a Facebook Page.',
        setupUrl: 'https://developers.facebook.com/apps/',
        uploadPageUrl: 'https://www.instagram.com/',
        fields: [
          { key: 'clientId', label: 'Meta app ID' },
          { key: 'clientSecret', label: 'App secret' },
        ],
        redirectUri: instagram.LOGIN_DONE,
      };
    });
  }

  configure(p: PublishPlatform, cfg: { clientId?: string; clientSecret?: string; tiktokMode?: 'inbox' | 'direct' }): PublishStatus[] {
    if (!PLATFORMS.includes(p)) throw new Error('Unknown platform');
    const cur = this.d.vault.get(p);
    const patch: Record<string, unknown> = {};
    const clean = (s: unknown) => (typeof s === 'string' ? s.trim().slice(0, 300) : undefined);
    if (cfg.clientId !== undefined) patch.clientId = clean(cfg.clientId) || undefined;
    if (cfg.clientSecret !== undefined && cfg.clientSecret !== '') patch.clientSecret = clean(cfg.clientSecret);
    if (cfg.tiktokMode && p === 'tiktok' && cfg.tiktokMode !== cur.tiktokMode) {
      patch.tiktokMode = cfg.tiktokMode;
      patch.tokens = undefined; // scopes differ, so sign in again
    }
    if (patch.clientId !== undefined && patch.clientId !== cur.clientId) patch.tokens = undefined;
    this.d.vault.set(p, patch);
    return this.status();
  }

  async connect(p: PublishPlatform): Promise<PublishStatus[]> {
    const acc = this.d.vault.get(p);
    if (p === 'youtube') {
      const r = await youtube.connect(acc, this.d.openBrowser, this.fetch);
      this.d.vault.set(p, { tokens: r.tokens, account: r.account });
    } else if (p === 'tiktok') {
      const r = await tiktok.connect(acc, this.d.openBrowser, this.fetch);
      this.d.vault.set(p, { tokens: r.tokens, account: r.account });
    } else {
      if (!acc.clientId || !acc.clientSecret) throw new Error('Add your Meta app ID and secret first.');
      const final = await this.d.loginWindow(instagram.loginUrl(acc.clientId), (u) => u.startsWith(instagram.LOGIN_DONE));
      const short = instagram.tokenFromRedirect(final);
      if (!short) throw new Error('Facebook sign-in did not finish.');
      const r = await instagram.finishLogin(acc, short, this.fetch);
      this.d.vault.set(p, { tokens: r.tokens, account: r.account, igUserId: r.igUserId });
    }
    return this.status();
  }

  disconnect(p: PublishPlatform, forgetKeys = false): PublishStatus[] {
    this.d.vault.clear(p, !forgetKeys);
    return this.status();
  }

  async upload(req: PublishRequest, onProgress: (p: Omit<PublishProgress, 'uploadId' | 'platform'>) => void): Promise<{ url?: string; message: string }> {
    if (!fs.existsSync(req.file)) throw new Error('The exported file is gone. Export again.');
    const acc = this.d.vault.get(req.platform);
    const caption = [req.description, req.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')].filter(Boolean).join('\n\n');
    if (req.platform === 'youtube') {
      const tokens = await youtube.fresh(acc, this.fetch);
      if (tokens !== acc.tokens) this.d.vault.set('youtube', { tokens });
      const r = await youtube.upload(tokens.access, req.file, { title: req.title, description: req.description, tags: req.tags, privacy: req.privacy, shorts: req.shorts }, (pct) => onProgress({ stage: 'uploading', pct: pct * 0.98, message: 'Uploading to YouTube' }), this.fetch);
      return { url: r.url, message: req.privacy === 'public' ? 'Uploaded to YouTube.' : `Uploaded to YouTube as ${req.privacy}.` };
    }
    if (req.platform === 'tiktok') {
      const tokens = await tiktok.fresh(acc, this.fetch);
      if (tokens !== acc.tokens) this.d.vault.set('tiktok', { tokens });
      const r = await tiktok.upload(acc, tokens.access, req.file, { title: caption || req.title, privacy: req.privacy }, (pct, message) => onProgress({ stage: pct >= 0.9 ? 'processing' : 'uploading', pct, message }), this.fetch);
      return { url: r.url, message: r.message };
    }
    const r = await instagram.upload(acc, req.file, caption || req.title, (pct, message) => onProgress({ stage: pct >= 0.7 ? 'processing' : 'uploading', pct, message }), this.fetch);
    return { url: r.url, message: 'Posted to Instagram.' };
  }
}
