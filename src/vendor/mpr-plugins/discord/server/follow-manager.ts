import type { Guild, VoiceState } from "discord.js";
import { getBot } from "./registry";

export interface FollowState {
  targetUserId: string;
  guildId: string;
}

export interface FollowMoveCommand {
  botName: string;
  action: "join";
  guildId: string;
  channelId: string;
}

const follows = new Map<string, FollowState>();

export function follow(
  botName: string,
  targetUserId: string,
  guildId: string,
  options: { guild?: Guild; syncNow?: boolean } = {},
): FollowState {
  const state = { targetUserId, guildId };
  follows.set(botName, state);
  if (options.guild && options.syncNow !== false) {
    joinTargetCurrentChannel(botName, targetUserId, options.guild).catch((error) => {
      console.warn(`[maw-discord-server] immediate follow join failed: ${error?.message ?? error}`);
    });
  }
  return state;
}

export function setFollow(
  botName: string,
  targetUserId: string,
  guildId: string,
): FollowState {
  return follow(botName, targetUserId, guildId);
}

export function unfollow(botName: string): boolean {
  return follows.delete(botName);
}

export const clearFollow = unfollow;

export function getFollow(botName: string): FollowState | undefined {
  return follows.get(botName);
}

export function getFollowersOf(
  targetUserId: string,
  guildId: string,
): Array<{ botName: string; state: FollowState }> {
  return Array.from(follows.entries())
    .filter(([, state]) => state.targetUserId === targetUserId && state.guildId === guildId)
    .map(([botName, state]) => ({ botName, state }));
}

export function handleVoiceStateUpdate(
  userId: string,
  newChannelId: string | null,
  guildId: string,
): FollowMoveCommand[] {
  if (!newChannelId) return [];
  return getFollowersOf(userId, guildId).map(({ botName }) => ({
    botName,
    action: "join",
    guildId,
    channelId: newChannelId,
  }));
}

export async function joinTargetCurrentChannel(
  botName: string,
  targetUserId: string,
  guild: Guild,
): Promise<FollowMoveCommand | null> {
  const channelId = await getMemberVoiceChannelId(guild, targetUserId);
  if (!channelId || botIsAlreadyInChannel(botName, guild.id, channelId)) return null;

  const command: FollowMoveCommand = {
    botName,
    action: "join",
    guildId: guild.id,
    channelId,
  };
  await postFollowCommand(command);
  return command;
}

export async function handleDiscordVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  if (oldState.channelId === newState.channelId) return;
  const commands = handleVoiceStateUpdate(
    newState.id,
    newState.channelId,
    newState.guild.id,
  );

  await Promise.all(commands.map((command) => postFollowCommand(command)));
}

async function postFollowCommand(command: FollowMoveCommand): Promise<void> {
  const bot = getBot(command.botName);
  if (!bot || bot.status !== "online" || !bot.commandUrl) return;

  const url = new URL(bot.commandUrl);
  if (!url.pathname.endsWith("/command")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/command`;
  }

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: command.action,
      guildId: command.guildId,
      channelId: command.channelId,
    }),
  });
}

async function getMemberVoiceChannelId(
  guild: Guild,
  userId: string,
): Promise<string | null> {
  const cached = guild.voiceStates.cache.get(userId)?.channelId;
  if (cached) return cached;

  const member = await guild.members.fetch(userId).catch(() => null);
  return member?.voice.channelId ?? null;
}

function botIsAlreadyInChannel(
  botName: string,
  guildId: string,
  channelId: string,
): boolean {
  const bot = getBot(botName);
  if (!bot?.currentChannel) return false;
  return bot.currentChannel.id === channelId &&
    (!bot.currentChannel.guildId || bot.currentChannel.guildId === guildId);
}
