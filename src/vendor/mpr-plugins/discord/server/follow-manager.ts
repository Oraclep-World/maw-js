import type { VoiceState } from "discord.js";
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
): FollowState {
  const state = { targetUserId, guildId };
  follows.set(botName, state);
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
