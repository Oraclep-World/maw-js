import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { follow, unfollow } from "./follow-manager";
import { getAllBots, getBot } from "./registry";

export type BotCommandAction =
  | "join"
  | "leave"
  | "mute"
  | "unmute"
  | "follow"
  | "unfollow"
  | "say"
  | "think";

export interface BotCommand {
  action: BotCommandAction;
  guildId?: string;
  channelId?: string;
  targetUserId?: string;
  text?: string;
  message?: string;
}

export interface CommandRouteResult {
  ok: boolean;
  botName: string;
  forwarded: boolean;
  status?: number;
  error?: string;
}

function commandEndpoint(commandUrl: string): string {
  const url = new URL(commandUrl);
  if (!url.pathname.endsWith("/command")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/command`;
  }
  return url.toString();
}

export async function sendCommand(
  botName: string,
  command: BotCommand,
): Promise<CommandRouteResult> {
  const bot = getBot(botName);
  if (!bot || bot.status !== "online") {
    return {
      ok: false,
      botName,
      forwarded: false,
      error: `bot '${botName}' is offline`,
    };
  }

  if (!bot.commandUrl) {
    return {
      ok: false,
      botName,
      forwarded: false,
      error: `bot '${botName}' has no commandUrl`,
    };
  }

  const res = await fetch(commandEndpoint(bot.commandUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }).catch((error: Error) => error);

  if (res instanceof Error) {
    return { ok: false, botName, forwarded: false, error: res.message };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      botName,
      forwarded: true,
      status: res.status,
      error: text || `bot command endpoint returned ${res.status}`,
    };
  }

  return { ok: true, botName, forwarded: true, status: res.status };
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const command = buildCommandFromInteraction(interaction);

  if (interaction.commandName === "bot-status") {
    await replyStatus(interaction, command.botName);
    return;
  }

  if (!command.botName) {
    await interaction.reply({
      content: "bot is required",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (command.command.action === "follow") {
    if (!command.command.targetUserId || !command.command.guildId) {
      await interaction.reply({
        content: "follow requires a guild and user",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    follow(command.botName, command.command.targetUserId, command.command.guildId);
  } else if (command.command.action === "unfollow") {
    unfollow(command.botName);
  }

  const result = await sendCommand(command.botName, command.command);
  const label = result.ok ? "sent" : "failed";
  await interaction.reply({
    content: result.ok
      ? `/${interaction.commandName} ${label} to ${command.botName}`
      : `/${interaction.commandName} ${label}: ${result.error}`,
    flags: MessageFlags.Ephemeral,
  });
}

function buildCommandFromInteraction(interaction: ChatInputCommandInteraction): {
  botName?: string;
  command: BotCommand;
} {
  const botName = interaction.options.getString("bot") ?? undefined;
  const guildId = interaction.guildId ?? undefined;

  switch (interaction.commandName) {
    case "bot-join":
      return {
        botName,
        command: {
          action: "join",
          guildId,
          channelId: interaction.options.getString("channel", true),
        },
      };
    case "bot-leave":
      return { botName, command: { action: "leave", guildId } };
    case "bot-mute":
      return { botName, command: { action: "mute", guildId } };
    case "bot-unmute":
      return { botName, command: { action: "unmute", guildId } };
    case "bot-follow":
      return {
        botName,
        command: {
          action: "follow",
          guildId,
          targetUserId: interaction.options.getString("user", true),
        },
      };
    case "bot-unfollow":
      return { botName, command: { action: "unfollow", guildId } };
    case "bot-say":
      return {
        botName,
        command: {
          action: "say",
          guildId,
          text: interaction.options.getString("text", true),
        },
      };
    case "bot-think":
      return {
        botName,
        command: {
          action: "think",
          guildId,
          message: interaction.options.getString("message", true),
        },
      };
    default:
      throw new Error(`unsupported command: ${interaction.commandName}`);
  }
}

async function replyStatus(
  interaction: ChatInputCommandInteraction,
  botName?: string,
): Promise<void> {
  const bots = botName ? [getBot(botName)].filter(Boolean) : getAllBots(interaction.guildId ?? undefined);
  if (bots.length === 0) {
    await interaction.reply({
      content: botName ? `bot '${botName}' is not registered` : "no bots registered",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: bots
      .map((bot) => {
        const channel = bot!.currentChannel?.name
          ? ` #${bot!.currentChannel.name}`
          : "";
        const followTarget = bot!.followTarget?.targetUserId
          ? ` follow=${bot!.followTarget.targetUserId}`
          : "";
        return `${bot!.botName}: ${bot!.status}${channel}${followTarget}`;
      })
      .join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}
