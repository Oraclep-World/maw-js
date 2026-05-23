import {
  REST,
  Routes,
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

type BotSlashCommand = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;

function withRequiredBot(command: SlashCommandBuilder): SlashCommandOptionsOnlyBuilder {
  return command.addStringOption((option) =>
    option
      .setName("bot")
      .setDescription("Online bot")
      .setRequired(true)
      .setAutocomplete(true),
  );
}

export const botSlashCommands: BotSlashCommand[] = [
  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-join")
      .setDescription("Ask a bot to join a voice channel"),
  ).addStringOption((option) =>
    option
      .setName("channel")
      .setDescription("Voice channel")
      .setRequired(true)
      .setAutocomplete(true),
  ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-leave")
      .setDescription("Ask a bot to leave voice and save transcript"),
  ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-mute")
      .setDescription("Mute bot speech responses"),
  ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-unmute")
      .setDescription("Unmute bot speech responses"),
  ),

  new SlashCommandBuilder()
    .setName("bot-status")
    .setDescription("Show bot status")
    .addStringOption((option) =>
      option
        .setName("bot")
        .setDescription("Online bot")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-follow")
      .setDescription("Make a bot follow a user between voice channels"),
  ).addStringOption((option) =>
    option
      .setName("user")
      .setDescription("Discord user")
      .setRequired(true)
      .setAutocomplete(true),
  ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-unfollow")
      .setDescription("Stop a bot from following its user"),
  ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-say")
      .setDescription("Ask a bot to speak text in voice"),
  ).addStringOption((option) =>
    option
      .setName("text")
      .setDescription("Text to speak")
      .setRequired(true),
  ),

  withRequiredBot(
    new SlashCommandBuilder()
      .setName("bot-think")
      .setDescription("Send a message to Claude and speak the answer"),
  ).addStringOption((option) =>
    option
      .setName("message")
      .setDescription("Message for Claude")
      .setRequired(true),
  ),
];

export function getSlashCommandPayloads(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return botSlashCommands.map((command) => command.toJSON());
}

export interface RegisterSlashCommandsOptions {
  token: string;
  applicationId: string;
  guildId?: string;
}

export async function registerSlashCommands(
  options: RegisterSlashCommandsOptions,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(options.token);
  const route = options.guildId
    ? Routes.applicationGuildCommands(options.applicationId, options.guildId)
    : Routes.applicationCommands(options.applicationId);
  await rest.put(route, { body: getSlashCommandPayloads() });
}
