export type BotStatus = "online" | "offline";

export interface ChannelRef {
  id: string;
  name?: string;
  guildId?: string;
}

export interface FollowRef {
  targetUserId: string;
  guildId: string;
}

export interface BotRegistryRecord {
  botName: string;
  guildIds: string[];
  status: BotStatus;
  currentChannel?: ChannelRef | null;
  followTarget?: FollowRef | null;
  lastHeartbeat: number;
  commandUrl?: string;
}

export interface RegisterPayload {
  botName: string;
  guildIds?: string[];
  commandUrl?: string;
  currentChannel?: ChannelRef | null;
  followTarget?: FollowRef | null;
}

export interface HeartbeatPayload {
  botName: string;
  currentChannel?: ChannelRef | null;
  followTarget?: FollowRef | null;
  guildIds?: string[];
  commandUrl?: string;
}

const HEARTBEAT_TIMEOUT_MS = 90_000;
const REAPER_INTERVAL_MS = 30_000;

const bots = new Map<string, BotRegistryRecord>();
let reaper: ReturnType<typeof setInterval> | undefined;

export function register(
  botName: string,
  guildIds: string[] = [],
  commandUrl?: string,
): BotRegistryRecord {
  const existing = bots.get(botName);
  const record: BotRegistryRecord = {
    botName,
    guildIds,
    status: "online",
    currentChannel: existing?.currentChannel ?? null,
    followTarget: existing?.followTarget ?? null,
    lastHeartbeat: Date.now(),
    commandUrl: commandUrl ?? existing?.commandUrl,
  };
  bots.set(botName, record);
  return record;
}

export function registerBot(payload: RegisterPayload): BotRegistryRecord {
  const record = register(payload.botName, payload.guildIds ?? [], payload.commandUrl);
  record.currentChannel = payload.currentChannel ?? record.currentChannel ?? null;
  record.followTarget = payload.followTarget ?? record.followTarget ?? null;
  return record;
}

export function deregister(botName: string): boolean {
  return bots.delete(botName);
}

export function deregisterBot(botName: string): boolean {
  return deregister(botName);
}

export function heartbeat(
  botName: string,
  currentChannel?: ChannelRef | null,
  followTarget?: FollowRef | null,
): BotRegistryRecord {
  const existing = bots.get(botName);
  const record: BotRegistryRecord = {
    botName,
    guildIds: existing?.guildIds ?? [],
    status: "online",
    currentChannel: currentChannel ?? existing?.currentChannel ?? null,
    followTarget: followTarget ?? existing?.followTarget ?? null,
    lastHeartbeat: Date.now(),
    commandUrl: existing?.commandUrl,
  };
  bots.set(botName, record);
  return record;
}

export function heartbeatBot(payload: HeartbeatPayload): BotRegistryRecord {
  const record = heartbeat(
    payload.botName,
    payload.currentChannel,
    payload.followTarget,
  );
  if (payload.guildIds) record.guildIds = payload.guildIds;
  if (payload.commandUrl) record.commandUrl = payload.commandUrl;
  return record;
}

export function markOffline(botName: string): void {
  const existing = bots.get(botName);
  if (!existing) return;
  bots.set(botName, { ...existing, status: "offline" });
}

export function markStaleBotsOffline(now = Date.now()): void {
  for (const bot of bots.values()) {
    if (bot.status === "online" && now - bot.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      markOffline(bot.botName);
    }
  }
}

export function startRegistryReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => markStaleBotsOffline(), REAPER_INTERVAL_MS);
  reaper.unref?.();
}

export function stopRegistryReaper(): void {
  if (!reaper) return;
  clearInterval(reaper);
  reaper = undefined;
}

export function getBots(guildId?: string): BotRegistryRecord[] {
  markStaleBotsOffline();
  const online = Array.from(bots.values()).filter((bot) => bot.status === "online");
  if (!guildId) return online;
  return online.filter((bot) => bot.guildIds.includes(guildId));
}

export function getAllBots(guildId?: string): BotRegistryRecord[] {
  markStaleBotsOffline();
  const all = Array.from(bots.values());
  if (!guildId) return all;
  return all.filter((bot) => bot.guildIds.includes(guildId));
}

export function getBot(botName: string): BotRegistryRecord | undefined {
  markStaleBotsOffline();
  return bots.get(botName);
}

export const listOnlineBots = getBots;
export const listBots = getAllBots;
