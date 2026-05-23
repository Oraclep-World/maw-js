import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
} from "discord.js";
import { handleAutocomplete } from "./autocomplete";
import { sendCommand, handleSlashCommand, type BotCommand } from "./command-router";
import { handleDiscordVoiceStateUpdate } from "./follow-manager";
import {
  deregisterBot,
  getAllBots,
  getBot,
  getBots,
  heartbeatBot,
  registerBot,
  startRegistryReaper,
  type HeartbeatPayload,
  type RegisterPayload,
} from "./registry";
import { registerSlashCommands } from "./slash-commands";

export { handleAutocomplete } from "./autocomplete";
export { sendCommand, handleSlashCommand } from "./command-router";
export {
  follow,
  unfollow,
  setFollow,
  clearFollow,
  getFollow,
  getFollowersOf,
  handleDiscordVoiceStateUpdate,
  handleVoiceStateUpdate,
} from "./follow-manager";
export {
  getAllBots,
  getBot,
  getBots,
  registerBot,
  deregisterBot,
  heartbeatBot,
} from "./registry";
export { getSlashCommandPayloads, registerSlashCommands } from "./slash-commands";

const DEFAULT_PORT = Number(process.env.MAW_DISCORD_SERVER_PORT ?? process.env.VOICE_SERVER_PORT) || 7799;

export interface StartServerOptions {
  port?: number;
  startDiscord?: boolean;
  registerCommands?: boolean;
  token?: string;
  applicationId?: string;
  guildId?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

export function startServer(options: StartServerOptions = {}): ReturnType<typeof Bun.serve> {
  const port = options.port ?? DEFAULT_PORT;
  startRegistryReaper();

  const server = Bun.serve({
    port,
    async fetch(req) {
      try {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
          return json({
            ok: true,
            service: "maw-discord-server",
            bots: getBots().length,
          });
        }

        if (req.method === "POST" && url.pathname === "/register") {
          const payload = await readJson<RegisterPayload>(req);
          if (!payload.botName) return json({ ok: false, error: "botName is required" }, 400);
          const bot = registerBot(payload);
          return json({ ok: true, bot });
        }

        if (req.method === "POST" && url.pathname === "/deregister") {
          const { botName } = await readJson<{ botName: string }>(req);
          if (!botName) return json({ ok: false, error: "botName is required" }, 400);
          return json({ ok: deregisterBot(botName) });
        }

        if (req.method === "POST" && url.pathname === "/heartbeat") {
          const payload = await readJson<HeartbeatPayload>(req);
          if (!payload.botName) return json({ ok: false, error: "botName is required" }, 400);
          const bot = heartbeatBot(payload);
          return json({ ok: true, bot });
        }

        if (req.method === "POST" && url.pathname === "/command") {
          const { botName, ...command } = await readJson<BotCommand & { botName: string }>(req);
          if (!botName) return json({ ok: false, error: "botName is required" }, 400);
          const result = await sendCommand(botName, command);
          return json(result, result.ok ? 200 : 502);
        }

        if (req.method === "GET" && url.pathname === "/bots") {
          const guildId = url.searchParams.get("guildId") ?? undefined;
          return json({ ok: true, bots: getAllBots(guildId) });
        }

        if (req.method === "GET" && url.pathname.startsWith("/bots/")) {
          const botName = decodeURIComponent(url.pathname.slice("/bots/".length));
          const bot = getBot(botName);
          return bot ? json({ ok: true, bot }) : json({ ok: false, error: "not found" }, 404);
        }

        return json({ ok: false, error: "not found" }, 404);
      } catch (error: any) {
        return json({ ok: false, error: error?.message ?? String(error) }, 500);
      }
    },
  });

  console.log(`[maw-discord-server] http listening on ${server.url}`);

  if (options.startDiscord ?? true) {
    startDiscordGateway(options).catch((error) => {
      console.warn(`[maw-discord-server] discord gateway disabled: ${error.message}`);
    });
  }

  return server;
}

export async function startDiscordGateway(options: StartServerOptions = {}): Promise<Client> {
  const token = options.token ?? process.env.MAW_DISCORD_TOKEN ?? process.env.DISCORD_TOKEN;
  const applicationId =
    options.applicationId ??
    process.env.MAW_DISCORD_APPLICATION_ID ??
    process.env.DISCORD_APPLICATION_ID ??
    process.env.DISCORD_CLIENT_ID;
  const guildId = options.guildId ?? process.env.MAW_DISCORD_GUILD_ID ?? process.env.DISCORD_GUILD_ID;

  if (!token) throw new Error("MAW_DISCORD_TOKEN or DISCORD_TOKEN is not set");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.GuildMember],
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`[maw-discord-server] discord ready as ${ready.user.tag}`);
    if ((options.registerCommands ?? true) && applicationId) {
      await registerSlashCommands({ token, applicationId, guildId });
      console.log(
        `[maw-discord-server] registered slash commands ${guildId ? `for guild ${guildId}` : "globally"}`,
      );
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
      } else if (interaction.isChatInputCommand() && interaction.commandName.startsWith("bot-")) {
        await handleSlashCommand(interaction as ChatInputCommandInteraction);
      }
    } catch (error: any) {
      console.warn(`[maw-discord-server] interaction failed: ${error?.message ?? error}`);
    }
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleDiscordVoiceStateUpdate(oldState, newState).catch((error) => {
      console.warn(`[maw-discord-server] follow update failed: ${error?.message ?? error}`);
    });
  });

  await client.login(token);
  return client;
}
