import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKeychain, writeKeychain, deleteKeychain, TEAMS_SERVICE } from '../keychain.ts';
import type {
  TeamsStatus,
  TeamsUser,
  TeamsChat,
  TeamsMessage,
  TeamsMessageAttachment,
  TeamsAttachmentInput,
  TeamsDeviceCodeAuth,
  TeamsSendRequest,
  TeamsDraftRequest,
  TeamsDraftResponse,
  TeamsTone,
} from './types.ts';
import { startProviderRun } from '../ai-providers.ts';
import { DEFAULT_AI_SELECTION, type AiSelection } from '../../src/lib/ai/types.ts';

const DEFAULT_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264'; // Microsoft Teams Native Client (pre-authorized in all Entra tenants)
const DEFAULT_TENANT_ID = 'organizations';

function getScopesForClient(clientId: string): string {
  if (clientId === DEFAULT_CLIENT_ID) {
    return 'offline_access https://graph.microsoft.com/.default';
  }
  return 'offline_access User.Read Chat.Read ChatMessage.Send Chat.ReadWrite';
}

const MR_REGEX = /(?:https?:\/\/)(?:gitlab[^\s<>"']+|github\.com[^\s<>"']+)\/(?:merge_requests|pull)\/\d+/gi;

interface StoredAuth {
  refreshToken: string;
  tenantId: string;
  clientId: string;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extractHtmlAttachments(html: string): TeamsMessageAttachment[] {
  if (!html) return [];
  const attachments: TeamsMessageAttachment[] = [];
  const imgRegex = /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.startsWith('data:image/') || src.startsWith('http://') || src.startsWith('https://')) {
      const altMatch = match[0].match(/alt=["']([^"']*)["']/i);
      attachments.push({
        name: altMatch?.[1] || 'Gambar',
        contentType: 'image',
        contentUrl: src,
      });
    }
  }
  const docRegex = /📎\s*<strong>([^<]+)<\/strong>/gi;
  while ((match = docRegex.exec(html)) !== null) {
    const name = match[1];
    attachments.push({
      name,
      contentType: 'document',
    });
  }
  return attachments;
}

export function cleanHtmlText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_match, href, text) => {
      const trimmed = text.replace(/<[^>]+>/g, '').trim();
      if (!trimmed || trimmed === href || trimmed.includes(href)) return href;
      return `${trimmed} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractMRUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(MR_REGEX);
  if (!matches) return [];
  return Array.from(new Set(matches.map((url) => url.replace(/[.,;!?]+$/, ''))));
}

export const TEAMS_TONE_INSTRUCTIONS: Record<TeamsTone, string> = {
  casual:
    'Gaya Santai & Ramah: Berkomunikasi seperti rekan developer yang bersahabat dan suportif (boleh gunakan sapaan wajar seperti mas/mba atau aku/kamu). Tetap jelas, solutif, dan tanpa bahasa birokratis kantor yang kaku.',
  professional:
    'Gaya Profesional: Komunikasi lugas, to the point, dan solutif sebagai Tech Lead. Fokus langsung pada aksi teknis, status, atau langkah konkrit berikutnya tanpa bertele-tele.',
  formal:
    'Gaya Formal & Sopan: Komunikasi santun dan terstruktur dengan bahasa baku kantor (gunakan sapaan Bapak/Ibu/Rekan-rekan). Cocok untuk manajemen, PM, atau stakeholder bisnis.',
  mentoring:
    'Gaya Mentoring & Edukatif: Nada membimbing, apresiatif, dan edukatif. Selain memberikan solusi atau feedback, jelaskan secara singkat alasan teknis (why) atau best practice arsitektur/clean code agar developer memahami konteks.',
  concise:
    'Gaya Singkat (ACK): Maksimal 1-2 kalimat pendek saja. Berikan konfirmasi cepat, pengakuan terima (acknowledgment), atau keputusan singkat tanpa kalimat pengantar panjang.',
};

export interface BuildTeamsDraftPromptInput {
  messages: Array<{
    sender: string;
    content: string;
    timestamp: string;
    isMe: boolean;
    detectedMRs?: string[];
  }>;
  instructions?: string;
  tone?: TeamsTone;
}

export function buildTeamsDraftPrompt(input: BuildTeamsDraftPromptInput): string {
  const recent = input.messages.slice(-15);

  let allDetectedMRs: string[] = [];
  for (const m of recent) {
    if (m.detectedMRs) allDetectedMRs.push(...m.detectedMRs);
  }
  allDetectedMRs = Array.from(new Set(allDetectedMRs));

  const transcript = recent
    .map((m) => `[${m.timestamp}] ${m.isMe ? 'Saya (Tech Lead)' : m.sender}: ${m.content}`)
    .join('\n');

  const tone = input.tone || 'casual';
  const toneInstruction = TEAMS_TONE_INSTRUCTIONS[tone] || TEAMS_TONE_INSTRUCTIONS.casual;

  return [
    'Kamu membantu seorang Tech Lead membalas pesan developer atau tim di Microsoft Teams dalam Bahasa Indonesia.',
    'Keluarkan HANYA teks balasan yang siap dikirim: tanpa pembuka seperti "Berikut draft", tanpa tanda kutip di awal/akhir, tanpa markdown heading besar.',
    `PEDOMAN GAYA BAHASA (TONE): ${toneInstruction}`,
    allDetectedMRs.length > 0
      ? `Developer mengirimkan link MR berikut:\n${allDetectedMRs.map((u) => `- ${u}`).join('\n')}\nPastikan respons menyapa progres MR ini sesuai konteks percakapan.`
      : '',
    '',
    '<percakapan_teams>',
    transcript || '(belum ada pesan)',
    '</percakapan_teams>',
    '',
    input.instructions?.trim()
      ? `Instruksi khusus dari Tech Lead: ${input.instructions.trim()}`
      : 'Tulis balasan yang tepat dan kontekstual untuk pesan terakhir dari lawan bicara.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Chat list cache: served as-is while fresh, then served while it refreshes in the background. */
const CHATS_FRESH_MS = 60_000;
const CHATS_STALE_MS = 15 * 60_000;

class TeamsSessionManager {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private currentUser: TeamsUser | null = null;
  private activeDeviceCodeAuth: TeamsDeviceCodeAuth | null = null;
  private activePollingAbort: AbortController | null = null;
  private currentTenantId = DEFAULT_TENANT_ID;
  private currentClientId = DEFAULT_CLIENT_ID;
  private lastError = '';

  // Skype Spaces / Teams Chat Service session
  private skypeToken: string | null = null;
  private skypeTokenExpiresAt = 0;
  private chatServiceHost = 'https://apac.ng.msg.teams.microsoft.com';
  private userCache = new Map<string, string>();
  private chatsCache?: { at: number; value: TeamsChat[] };
  private chatsInflight?: Promise<TeamsChat[]>;

  constructor() {
    this.currentTenantId = process.env.TEAMS_TENANT_ID || DEFAULT_TENANT_ID;
    this.currentClientId = process.env.TEAMS_CLIENT_ID || DEFAULT_CLIENT_ID;
  }

  async getStoredAuth(): Promise<StoredAuth | null> {
    const raw = (await readKeychain(TEAMS_SERVICE)) || process.env.TEAMS_REFRESH_TOKEN;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.refreshToken) {
        return {
          refreshToken: parsed.refreshToken,
          tenantId: parsed.tenantId || this.currentTenantId,
          clientId: parsed.clientId || this.currentClientId,
        };
      }
    } catch {
      // Legacy plain refresh token string
      return {
        refreshToken: raw,
        tenantId: this.currentTenantId,
        clientId: this.currentClientId,
      };
    }
    return null;
  }

  async saveAuth(auth: StoredAuth): Promise<void> {
    this.currentTenantId = auth.tenantId;
    this.currentClientId = auth.clientId;
    await writeKeychain(TEAMS_SERVICE, JSON.stringify(auth));
  }

  async clearAuth(): Promise<void> {
    this.invalidateChats();
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.currentUser = null;
    this.activeDeviceCodeAuth = null;
    this.skypeToken = null;
    this.skypeTokenExpiresAt = 0;
    this.userCache.clear();
    if (this.activePollingAbort) {
      this.activePollingAbort.abort();
      this.activePollingAbort = null;
    }
    await deleteKeychain(TEAMS_SERVICE);
  }

  async getSkypeSession(): Promise<{ skypeToken: string; chatHost: string } | null> {
    if (this.skypeToken && Date.now() < this.skypeTokenExpiresAt - 120_000) {
      return { skypeToken: this.skypeToken, chatHost: this.chatServiceHost };
    }

    const stored = await this.getStoredAuth();
    if (!stored?.refreshToken) return null;

    try {
      const tenant = stored.tenantId || this.currentTenantId;
      const clientId = stored.clientId || this.currentClientId;

      // 1. Acquire Skype Spaces access token
      const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: stored.refreshToken,
          scope: 'https://api.spaces.skype.com/.default',
        }),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as any;
      const skypeAccessToken = data.access_token;
      if (!skypeAccessToken) return null;

      // 2. Exchange with Teams Auth Service for SkypeToken and chat routing
      const authzRes = await fetch('https://teams.microsoft.com/api/authsvc/v1.0/authz', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${skypeAccessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!authzRes.ok) return null;
      const authzData = (await authzRes.json()) as any;
      const skypeToken = authzData.tokens?.skypeToken;
      if (!skypeToken) return null;

      this.skypeToken = skypeToken;
      this.chatServiceHost = authzData.regionGtms?.chatService || 'https://apac.ng.msg.teams.microsoft.com';
      this.skypeTokenExpiresAt = Date.now() + (authzData.tokens?.expiresIn || 86400) * 1000;

      return { skypeToken, chatHost: this.chatServiceHost };
    } catch {
      return null;
    }
  }

  async resolveUserDisplayName(userId: string, token: string): Promise<string | null> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.displayName) {
          this.userCache.set(userId, data.displayName);
          return data.displayName;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  async getAccessToken(): Promise<string | null> {
    // If memory token is valid for at least 60 seconds
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const stored = await this.getStoredAuth();
    if (!stored?.refreshToken) return null;

    try {
      const tenant = stored.tenantId || this.currentTenantId;
      const clientId = stored.clientId || this.currentClientId;
      const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: stored.refreshToken,
          scope: getScopesForClient(clientId),
        }),
      });

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as any;
        this.lastError = errJson.error_description || `Failed to refresh token: HTTP ${res.status}`;
        return null;
      }

      const data = (await res.json()) as any;
      this.accessToken = data.access_token;
      this.accessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

      if (data.refresh_token && data.refresh_token !== stored.refreshToken) {
        await this.saveAuth({
          refreshToken: data.refresh_token,
          tenantId: tenant,
          clientId,
        });
      }

      this.lastError = '';
      return this.accessToken;
    } catch (e: any) {
      this.lastError = e?.message || 'Error refreshing access token';
      return null;
    }
  }

  async getStatus(): Promise<TeamsStatus> {
    const token = await this.getAccessToken();
    if (token) {
      if (!this.currentUser) {
        await this.fetchProfile(token);
      }
      return {
        connected: true,
        user: this.currentUser ?? undefined,
        tenantId: this.currentTenantId,
        clientId: this.currentClientId,
      };
    }

    return {
      connected: false,
      tenantId: this.currentTenantId,
      clientId: this.currentClientId,
      deviceCodeAuth: this.activeDeviceCodeAuth ?? undefined,
      error: this.lastError || undefined,
    };
  }

  async fetchProfile(token: string): Promise<TeamsUser | null> {
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      this.currentUser = {
        id: data.id,
        displayName: data.displayName || 'User',
        email: data.mail || data.userPrincipalName || '',
        jobTitle: data.jobTitle,
      };
      return this.currentUser;
    } catch {
      return null;
    }
  }

  async startDeviceCodeLogin(tenantId?: string, clientId?: string): Promise<TeamsDeviceCodeAuth> {
    if (this.activePollingAbort) {
      this.activePollingAbort.abort();
      this.activePollingAbort = null;
    }

    const tenant = tenantId?.trim() || this.currentTenantId;
    const client = clientId?.trim() || this.currentClientId;
    this.currentTenantId = tenant;
    this.currentClientId = client;
    this.lastError = '';

    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client,
        scope: getScopesForClient(client),
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as any;
      throw new Error(err.error_description || `Device code request failed (HTTP ${res.status})`);
    }

    const data = (await res.json()) as any;
    const auth: TeamsDeviceCodeAuth = {
      userCode: data.user_code,
      verificationUri: data.verification_uri || 'https://login.microsoft.com/device',
      message: data.message,
      expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    };

    this.activeDeviceCodeAuth = auth;

    // Start background poller
    const abortCtrl = new AbortController();
    this.activePollingAbort = abortCtrl;
    const intervalSec = Math.max(Number(data.interval) || 5, 5);

    this.pollForToken(tenant, client, data.device_code, intervalSec, auth.expiresAt, abortCtrl.signal).catch(
      (err) => {
        if (!abortCtrl.signal.aborted) {
          this.lastError = err.message;
        }
      }
    );

    return auth;
  }

  private async pollForToken(
    tenant: string,
    client: string,
    deviceCode: string,
    intervalSec: number,
    expiresAt: number,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted && Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
      if (signal.aborted) break;

      try {
        const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: client,
            device_code: deviceCode,
          }),
          signal,
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          this.accessToken = data.access_token;
          this.accessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
          this.activeDeviceCodeAuth = null;
          this.activePollingAbort = null;

          if (data.refresh_token) {
            await this.saveAuth({
              refreshToken: data.refresh_token,
              tenantId: tenant,
              clientId: client,
            });
          }

          await this.fetchProfile(data.access_token);
          return;
        }

        const errJson = (await res.json().catch(() => ({}))) as any;
        if (errJson.error === 'authorization_pending') {
          continue;
        } else if (errJson.error === 'slow_down') {
          intervalSec += 5;
          continue;
        } else {
          this.lastError = errJson.error_description || `Login failed: ${errJson.error}`;
          this.activeDeviceCodeAuth = null;
          return;
        }
      } catch (e: any) {
        if (signal.aborted) return;
        // Network blip, retry next interval
      }
    }

    this.activeDeviceCodeAuth = null;
  }

  cancelLogin(): void {
    if (this.activePollingAbort) {
      this.activePollingAbort.abort();
      this.activePollingAbort = null;
    }
    this.activeDeviceCodeAuth = null;
  }

  /**
   * Chat list for the Teams page. Loading it means many Microsoft calls (conversations, names of
   * 1:1 partners, teams, channels, each channel's last message), so they run in parallel and the
   * result is cached: fresh for CHATS_FRESH_MS, then served immediately while a background refresh
   * runs (up to CHATS_STALE_MS). `fresh` forces a reload (the refresh button).
   */
  async getChats(opts: { fresh?: boolean } = {}): Promise<TeamsChat[]> {
    const cache = this.chatsCache;
    const age = cache ? Date.now() - cache.at : Infinity;
    if (cache && !opts.fresh && age < CHATS_FRESH_MS) return cache.value;
    if (cache && !opts.fresh && age < CHATS_STALE_MS) {
      void this.refreshChats().catch(() => {});
      return cache.value;
    }
    return this.refreshChats();
  }

  /** Drops the cached chat list (after sending, or on logout). */
  invalidateChats(): void {
    this.chatsCache = undefined;
  }

  private refreshChats(): Promise<TeamsChat[]> {
    this.chatsInflight ??= this.loadChats()
      .then((value) => {
        this.chatsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => (this.chatsInflight = undefined));
    return this.chatsInflight;
  }

  private async loadChats(): Promise<TeamsChat[]> {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Microsoft Teams belum terhubung.');

    if (!this.currentUser) {
      await this.fetchProfile(token);
    }
    const myUserId = this.currentUser?.id;
    const myName = this.currentUser?.displayName;

    // Chats (Teams chat service) and channels (Graph) are independent: load both at once.
    const [direct, channels] = await Promise.all([this.loadConversations(token, myUserId, myName), this.loadChannels(token)]);
    const seen = new Set(direct.map((c) => c.id));
    const result = [...direct, ...channels.filter((c) => !seen.has(c.id) && !seen.has(c.rawChannelId)).map(({ rawChannelId: _r, ...c }) => c)];

    // Sort all chats by last updated date descending
    result.sort((a, b) => {
      const timeA = new Date(a.lastUpdatedDateTime || 0).getTime();
      const timeB = new Date(b.lastUpdatedDateTime || 0).getTime();
      return timeB - timeA;
    });

    return result;
  }

  /** Direct chats, group chats, meetings and notes via the Teams chat service (Skype Spaces). */
  private async loadConversations(token: string, myUserId: string | undefined, myName: string | undefined): Promise<TeamsChat[]> {
    try {
      const skype = await this.getSkypeSession();
      if (!skype) return [];
      const convRes = await fetch(`${skype.chatHost}/v1/users/ME/conversations?pageSize=50&view=msnp24Equivalent`, {
        headers: {
          Authentication: `skypetoken=${skype.skypeToken}`,
          BehaviorOverride: 'redirectAs404',
          Accept: 'application/json',
        },
      });
      if (!convRes.ok) return [];
      const convData = (await convRes.json()) as any;
      const conversations = (convData.conversations || []).filter((c: any) => {
        const threadType = c.threadProperties?.productThreadType || c.type;
        // Skip internal streams
        return !['StreamOfNotifications', 'StreamOfMentions', 'StreamOfCallLogs', 'TeamsTeam'].includes(threadType);
      });

      // Names of 1:1 partners not in the last message are looked up in parallel.
      return await Promise.all(
        conversations.map(async (c: any): Promise<TeamsChat> => {
          const threadType = c.threadProperties?.productThreadType || c.type;
          let chatType: 'oneOnOne' | 'group' | 'meeting' | 'channel' | 'notes' | string = 'group';
          let title = c.threadProperties?.topic || '';

          if (threadType === 'OneToOneChat' || c.id.includes('@unq.gbl.spaces')) {
            chatType = 'oneOnOne';
            const match = c.id.match(/^19:([0-9a-f-]+)_([0-9a-f-]+)@unq\.gbl\.spaces/i);
            let otherId: string | null = null;
            if (match) {
              otherId = match[1] === myUserId ? match[2] : match[1];
            }

            if (c.lastMessage?.imdisplayname && c.lastMessage.imdisplayname !== myName) {
              title = c.lastMessage.imdisplayname;
              if (otherId) this.userCache.set(otherId, title);
            } else if (otherId) {
              const resolved = await this.resolveUserDisplayName(otherId, token);
              title = resolved || title || 'Direct Chat';
            } else {
              title = title || 'Direct Chat';
            }
          } else if (threadType === 'Meeting') {
            chatType = 'meeting';
            title = title || 'Meeting Chat';
          } else if (threadType === 'StreamOfNotes' || c.id === '48:notes') {
            chatType = 'notes';
            title = 'Catatan Pribadi';
          } else if (threadType === 'TeamsStandardChannel') {
            chatType = 'channel';
            title = title ? `#${title}` : 'Channel';
          } else {
            chatType = 'group';
            title = title || 'Group Chat';
          }

          let previewText = '';
          let senderName = '';
          let timestamp = c.lastUpdatedDateTime || new Date(c.version || Date.now()).toISOString();

          if (c.lastMessage && c.lastMessage.messagetype !== 'Event/Call') {
            previewText = cleanHtmlText(c.lastMessage.content || '');
            senderName = c.lastMessage.imdisplayname || '';
            if (c.lastMessage.composetime) {
              timestamp = c.lastMessage.composetime;
            }
          }

          const detectedMRs = extractMRUrls(previewText);
          return {
            id: c.id,
            title,
            chatType,
            lastUpdatedDateTime: timestamp,
            lastMessage: previewText ? { preview: previewText.slice(0, 100), sender: senderName, timestamp } : undefined,
            detectedMRs: detectedMRs.length > 0 ? detectedMRs : undefined,
          };
        }),
      );
    } catch {
      // Skype Spaces fetch blip
      return [];
    }
  }

  /** Channels of the user's teams via Microsoft Graph, each with its last message; all in parallel. */
  private async loadChannels(token: string): Promise<(TeamsChat & { rawChannelId: string })[]> {
    const graph = (path: string) => fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
    try {
      const teamsRes = await graph('/me/joinedTeams');
      if (!teamsRes.ok) return [];
      const teams = ((await teamsRes.json()) as any).value || [];
      const perTeam = await Promise.all(
        teams.map(async (t: any) => {
          try {
            const chRes = await graph(`/teams/${t.id}/channels`);
            if (!chRes.ok) return [];
            const channels = ((await chRes.json()) as any).value || [];
            return await Promise.all(
              channels.map(async (ch: any) => {
                let lastMsgPreview: { preview: string; sender: string; timestamp: string } | undefined;
                let detectedMRs: string[] = [];
                try {
                  const msgRes = await graph(`/teams/${t.id}/channels/${encodeURIComponent(ch.id)}/messages?$top=1`);
                  if (msgRes.ok) {
                    const firstMsg = ((await msgRes.json()) as any).value?.[0];
                    if (firstMsg && firstMsg.body?.content) {
                      const previewText = cleanHtmlText(firstMsg.body.content);
                      const senderName = firstMsg.from?.user?.displayName || 'System';
                      if (previewText && previewText !== '<systemEventMessage/>') {
                        lastMsgPreview = { preview: previewText.slice(0, 100), sender: senderName, timestamp: firstMsg.createdDateTime };
                        detectedMRs = extractMRUrls(previewText);
                      }
                    }
                  }
                } catch {
                  // ignore channel message preview blip
                }
                return {
                  id: `channel:${t.id}:${ch.id}`,
                  rawChannelId: ch.id as string,
                  title: `[${t.displayName}] #${ch.displayName}`,
                  chatType: 'channel',
                  lastUpdatedDateTime: lastMsgPreview?.timestamp || ch.createdDateTime || new Date().toISOString(),
                  lastMessage: lastMsgPreview,
                  detectedMRs: detectedMRs.length > 0 ? detectedMRs : undefined,
                };
              }),
            );
          } catch {
            return []; // Channel fetch blip
          }
        }),
      );
      return perTeam.flat();
    } catch {
      return []; // Teams fetch error
    }
  }

  async getMessages(chatId: string): Promise<TeamsMessage[]> {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Microsoft Teams belum terhubung.');

    if (!this.currentUser) {
      await this.fetchProfile(token);
    }
    const myUserId = this.currentUser?.id;

    if (chatId.startsWith('channel:')) {
      const parts = chatId.split(':');
      const teamId = parts[1];
      const channelId = parts.slice(2).join(':');
      const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages?$top=30`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as any;
        throw new Error(err.error?.message || `Gagal mengambil pesan channel (HTTP ${res.status})`);
      }

      const json = (await res.json()) as any;
      const items = (json.value || []).reverse(); // Oldest to newest

      return items
        .filter((m: any) => m.body?.content && !m.body.content.includes('<systemEventMessage/>'))
        .map((m: any) => {
          const rawContent = m.body?.content || '';
          const text = cleanHtmlText(rawContent);
          const sender = m.from?.user?.displayName || 'System';
          const senderId = m.from?.user?.id;
          const isMe = Boolean(myUserId && senderId === myUserId);
          const detected = extractMRUrls(text);

          const atts: TeamsMessageAttachment[] = [];
          if (Array.isArray(m.attachments)) {
            for (const a of m.attachments) {
              if (a.name || a.contentUrl) {
                atts.push({
                  name: a.name || 'Lampiran',
                  contentType: a.contentType,
                  contentUrl: a.contentUrl,
                  thumbnailUrl: a.thumbnailUrl,
                });
              }
            }
          }
          const htmlAtts = extractHtmlAttachments(rawContent);
          for (const ha of htmlAtts) {
            if (!atts.some((existing) => existing.contentUrl === ha.contentUrl || existing.name === ha.name)) {
              atts.push(ha);
            }
          }

          return {
            id: m.id,
            sender,
            senderId,
            isMe,
            timestamp: m.createdDateTime,
            content: text,
            detectedMRs: detected.length > 0 ? detected : undefined,
            attachments: atts.length > 0 ? atts : undefined,
          };
        });
    }

    // Direct / Group / Meeting / Notes Chat via Teams Chat API (Skype Spaces)
    const skype = await this.getSkypeSession();
    if (!skype) {
      throw new Error('Sesi chat Microsoft Teams tidak tersedia.');
    }

    const res = await fetch(
      `${skype.chatHost}/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?pageSize=30`,
      {
        headers: {
          Authentication: `skypetoken=${skype.skypeToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as any;
      throw new Error(err.message || `Gagal mengambil pesan (HTTP ${res.status})`);
    }

    const json = (await res.json()) as any;
    const items = (json.messages || []).slice().reverse(); // Oldest to newest

    return items
      .filter((m: any) => m.content && m.messagetype !== 'Event/Call')
      .map((m: any) => {
        const rawContent = m.content || '';
        const text = cleanHtmlText(rawContent);
        const sender = m.imdisplayname || (m.from?.includes(myUserId || '') ? (this.currentUser?.displayName || 'Saya') : 'User');
        const fromMatch = (m.from || '').match(/orgid:([0-9a-f-]+)/i);
        const senderId = fromMatch ? fromMatch[1] : undefined;
        const isMe = Boolean(myUserId && (m.from?.includes(myUserId) || senderId === myUserId));
        const detected = extractMRUrls(text);
        const atts = extractHtmlAttachments(rawContent);

        return {
          id: String(m.id || m.sequenceId || m.clientmessageid || Date.now()),
          sender: isMe ? (this.currentUser?.displayName || 'Saya') : sender,
          senderId,
          isMe,
          timestamp: m.composetime || new Date().toISOString(),
          content: text,
          detectedMRs: detected.length > 0 ? detected : undefined,
          attachments: atts.length > 0 ? atts : undefined,
        };
      });
  }

  /**
   * `opts.html` sends ready-made HTML instead of the escaped text; only for HTML the connector
   * built itself from data (every value escaped), never for text typed by a user or an AI.
   */
  async sendMessage(chatId: string, content: string, attachment?: TeamsAttachmentInput, opts: { html?: string } = {}): Promise<{ ok: true; id: string }> {
    this.invalidateChats(); // the chat's last message changes
    const token = await this.getAccessToken();
    if (!token) throw new Error('Microsoft Teams belum terhubung.');

    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>');

    let htmlContent = `<p>${escaped}</p>`;
    if (attachment) {
      if (attachment.mimetype.startsWith('image/')) {
        const imgTag = `<p><img src="data:${attachment.mimetype};base64,${attachment.data}" alt="${attachment.filename}" style="max-width:100%;max-height:400px;border-radius:6px;margin-top:6px;"/></p>`;
        htmlContent = content.trim() ? `<p>${escaped}</p>${imgTag}` : imgTag;
      } else {
        const sizeStr = attachment.size ? ` (${formatBytes(attachment.size)})` : '';
        const docCard = `<div style="display:inline-block;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;background-color:#f9fafb;margin-top:6px;font-family:sans-serif;">📎 <strong>${attachment.filename}</strong><span style="color:#6b7280;font-size:12px;">${sizeStr}</span></div>`;
        htmlContent = content.trim() ? `<p>${escaped}</p>${docCard}` : docCard;
      }
    }
    if (opts.html) htmlContent = opts.html;

    if (chatId.startsWith('channel:')) {
      const parts = chatId.split(':');
      const teamId = parts[1];
      const channelId = parts.slice(2).join(':');
      const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          body: {
            contentType: 'html',
            content: htmlContent,
          },
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as any;
        throw new Error(err.error?.message || `Gagal mengirim pesan channel (HTTP ${res.status})`);
      }

      const data = (await res.json()) as any;
      return { ok: true, id: data.id };
    }

    // Direct / Group / Meeting / Notes chat via Teams Chat API (Skype Spaces)
    const skype = await this.getSkypeSession();
    if (!skype) {
      throw new Error('Sesi chat Microsoft Teams tidak tersedia.');
    }

    const clientMsgId = String(Date.now());
    const res = await fetch(
      `${skype.chatHost}/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authentication: `skypetoken=${skype.skypeToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          content: htmlContent,
          messagetype: 'RichText/Html',
          contenttype: 'text',
          clientmessageid: clientMsgId,
        }),
      }
    );

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as any;
      throw new Error(err.message || `Gagal mengirim pesan (HTTP ${res.status})`);
    }

    return { ok: true, id: clientMsgId };
  }

  async draftReply(req: TeamsDraftRequest): Promise<TeamsDraftResponse> {
    const messages = await this.getMessages(req.chatId);
    const recent = messages.slice(-15);
    const prompt = buildTeamsDraftPrompt({
      messages: recent,
      instructions: req.instructions,
      tone: req.tone,
    });

    const selection: AiSelection = {
      provider: (req.provider as any) || DEFAULT_AI_SELECTION.provider,
      model: req.model || DEFAULT_AI_SELECTION.model,
    };

    const cwd = await mkdtemp(join(tmpdir(), 'tlc-teams-'));
    try {
      const { reply, error } = await startProviderRun(selection, 'text', prompt, {
        cwd,
        timeoutMs: 120_000,
        systemPrompt:
          'Kamu membantu seorang Tech Lead membalas pesan developer atau tim di Microsoft Teams dalam Bahasa Indonesia.',
      }).done;

      if (error) throw new Error(error);

      return {
        draft: (reply || '').trim(),
        provider: selection.provider,
        model: selection.model,
      };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

export const teamsSession = new TeamsSessionManager();
