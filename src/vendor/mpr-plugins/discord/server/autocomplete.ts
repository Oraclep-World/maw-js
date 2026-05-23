import {
  ChannelType,
  type AutocompleteInteraction,
  type ApplicationCommandOptionChoiceData,
} from "discord.js";
import { getBots } from "./registry";

export type AutocompleteChoice = ApplicationCommandOptionChoiceData<string>;

export function autocompleteBots(guildId?: string, query = ""): AutocompleteChoice[] {
  const needle = query.toLowerCase();
  return getBots(guildId)
    .filter((bot) => bot.botName.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((bot) => ({
      name: `${bot.botName} 🟢${bot.currentChannel?.name ? ` #${bot.currentChannel.name}` : ""}`,
      value: bot.botName,
    }));
}

export async function autocompleteVoiceChannels(
  interaction: AutocompleteInteraction,
  query = "",
): Promise<AutocompleteChoice[]> {
  if (!interaction.guild) return [];
  const needle = query.toLowerCase();
  const channels = await interaction.guild.channels.fetch();
  return channels
    .filter((channel) =>
      Boolean(channel) &&
      (channel!.type === ChannelType.GuildVoice ||
        channel!.type === ChannelType.GuildStageVoice) &&
      channel!.name.toLowerCase().includes(needle),
    )
    .map((channel) => ({
      name: channel!.name,
      value: channel!.id,
    }))
    .slice(0, 25);
}

export async function autocompleteUsers(
  interaction: AutocompleteInteraction,
  query = "",
): Promise<AutocompleteChoice[]> {
  if (!interaction.guild) return [];
  const members = await interaction.guild.members.fetch({
    query,
    limit: 25,
  });
  return members
    .map((member) => ({
      name: member.displayName || member.user.globalName || member.user.username,
      value: member.id,
    }))
    .slice(0, 25);
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "");

  if (focused.name === "bot") {
    await interaction.respond(autocompleteBots(interaction.guildId ?? undefined, query));
    return;
  }

  if (focused.name === "channel") {
    await interaction.respond(await autocompleteVoiceChannels(interaction, query));
    return;
  }

  if (focused.name === "user") {
    await interaction.respond(await autocompleteUsers(interaction, query));
    return;
  }

  await interaction.respond([]);
}
