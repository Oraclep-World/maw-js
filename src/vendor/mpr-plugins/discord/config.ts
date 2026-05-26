import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DiscordBotConfig {
  appId?: string;
  tokenName?: string;
  voiceProfile?: string;
}

export interface DiscordDefaultsConfig {
  ownerIds?: string;
  typhoonApiKey?: string;
  groqApiKey?: string;
  mqttUrl?: string;
  mqttUser?: string;
  mqttPass?: string;
  claudeModel?: string;
  voiceProfile?: string;
  serverUrl?: string;
}

export interface DiscordConfig {
  discord?: {
    bots?: Record<string, DiscordBotConfig>;
    defaults?: DiscordDefaultsConfig;
  };
}

export interface ResolvedDiscordBotConfig extends DiscordBotConfig {
  bot: string;
}

export function discordConfigPath(): string {
  return process.env.MAW_DISCORD_CONFIG ?? join(homedir(), ".maw", "discord.json");
}

export function loadDiscordConfig(): DiscordConfig {
  const path = discordConfigPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as DiscordConfig;
}

export function discordDefaults(config = loadDiscordConfig()): DiscordDefaultsConfig {
  return config.discord?.defaults ?? {};
}

export function configuredBots(config = loadDiscordConfig()): ResolvedDiscordBotConfig[] {
  const bots = config.discord?.bots ?? {};
  return Object.entries(bots).map(([bot, botConfig]) => ({ bot, ...botConfig }));
}

export function firstConfiguredBot(
  config = loadDiscordConfig(),
): ResolvedDiscordBotConfig | null {
  return configuredBots(config)[0] ?? null;
}

export function resolveConfiguredBot(
  bot: string | undefined,
  config = loadDiscordConfig(),
): ResolvedDiscordBotConfig | null {
  if (bot) {
    return { bot, ...(config.discord?.bots?.[bot] ?? {}) };
  }
  return firstConfiguredBot(config);
}
