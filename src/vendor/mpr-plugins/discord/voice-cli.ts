import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { decryptToken, findGhqPath, listPassTokens } from "./lib";
import {
  configuredBots,
  discordDefaults,
  loadDiscordConfig,
  type DiscordDefaultsConfig,
} from "./config";

interface VoiceBotConfig {
  bot: string;
  voiceProfile?: string;
  tokenName?: string;
  appId?: string;
}

interface VoiceCliOpts {
  all: boolean;
  serverUrl: string;
  voiceProfile?: string;
}

const DEFAULT_SERVER_URL = "http://localhost:7799";

function parseOpts(args: string[]): VoiceCliOpts & { bot?: string } {
  const defaults = discordDefaults();
  const opts: VoiceCliOpts & { bot?: string } = {
    all: args.includes("--all"),
    serverUrl: process.env.MAW_DISCORD_SERVER_URL ?? defaults.serverUrl ?? DEFAULT_SERVER_URL,
    voiceProfile: defaults.voiceProfile,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--server" && args[i + 1]) {
      opts.serverUrl = args[++i]!;
    } else if (arg === "--voice-profile" && args[i + 1]) {
      opts.voiceProfile = args[++i]!;
    } else if (arg === "--all") {
      opts.all = true;
    } else if (!arg.startsWith("--") && !opts.bot) {
      opts.bot = arg;
    }
  }
  return opts;
}

function pidPath(bot: string): string {
  return join(homedir(), ".claude", "channels", bot, "voice-bot.pid");
}

function readPid(bot: string): number | null {
  try {
    const raw = readFileSync(pidPath(bot), "utf8").trim();
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writePid(bot: string, pid: number): void {
  const path = pidPath(bot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`);
}

function removePid(bot: string): void {
  try {
    unlinkSync(pidPath(bot));
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function configPaths(): string[] {
  return [
    process.env.MAW_DISCORD_BOTS_JSON,
    join(process.cwd(), "bots.json"),
    join(homedir(), ".config", "maw", "discord", "bots.json"),
    join(homedir(), ".claude", "channels", "discord", "bots.json"),
  ].filter(Boolean) as string[];
}

function loadConfiguredBots(): VoiceBotConfig[] {
  const config = loadDiscordConfig();
  const configBots = configuredBots(config);
  if (configBots.length > 0) return configBots;

  for (const path of configPaths()) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as
      | { bots?: VoiceBotConfig[] | Record<string, Omit<VoiceBotConfig, "bot">> }
      | VoiceBotConfig[]
      | Record<string, Omit<VoiceBotConfig, "bot">>;
    if (Array.isArray(parsed)) return parsed;
    if ("bots" in parsed && Array.isArray(parsed.bots)) return parsed.bots;
    const record = "bots" in parsed && parsed.bots ? parsed.bots : parsed;
    return Object.entries(record).map(([bot, cfg]) => ({ bot, ...cfg }));
  }
  return listPassTokens().map((token) => ({ bot: token.bot, tokenName: token.name }));
}

async function resolveVoiceBotRepo(): Promise<string> {
  return (
    (await findGhqPath("voice-bot")) ??
    join(homedir(), "ghq", "github.com", "Soul-Brews-Studio", "voice-bot")
  );
}

async function resolveOracleRepo(bot: string): Promise<string | null> {
  return findGhqPath(bot);
}

async function resolveToken(bot: string, tokenName?: string): Promise<string> {
  const tokens = listPassTokens();
  const entry = tokenName
    ? tokens.find(
        (token) =>
          token.name === tokenName ||
          token.name === `${tokenName}-token` ||
          token.bot === tokenName,
      )
    : tokens.find((token) => token.bot === bot || token.name === `${bot}-token`);
  if (!entry) throw new Error(`no pass token for ${bot}`);
  const token = await decryptToken(entry.name);
  if (!token) throw new Error(`failed to decrypt discord/${entry.name}`);
  return token;
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function defaultEnv(defaults: DiscordDefaultsConfig): Record<string, string> {
  const claudeModel = defaults.claudeModel ?? "sonnet";
  return compactEnv({
    DC_OWNER_IDS: defaults.ownerIds,
    TYPHOON_API_KEY: defaults.typhoonApiKey,
    GROQ_API_KEY: defaults.groqApiKey,
    MQTT_URL: defaults.mqttUrl,
    MQTT_USER: defaults.mqttUser,
    MQTT_PASS: defaults.mqttPass,
    CLAUDE_MODEL: claudeModel,
    CLAUDE_ARGS: `--model ${claudeModel}`,
    VOICE_PROFILE: defaults.voiceProfile,
  });
}

async function serverBot(serverUrl: string, bot: string): Promise<any | null> {
  try {
    const res = await fetch(new URL(`/bots/${encodeURIComponent(bot)}`, serverUrl));
    if (!res.ok) return null;
    const data = await res.json() as { bot?: any };
    return data.bot ?? null;
  } catch {
    return null;
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function wakeOne(
  log: (s: string) => void,
  bot: VoiceBotConfig,
  opts: VoiceCliOpts,
): Promise<void> {
  const existing = readPid(bot.bot);
  if (existing && isAlive(existing)) {
    log(`✓ ${bot.bot} already online (pid ${existing})`);
    return;
  }

  const repo = await resolveVoiceBotRepo();
  const oracleRepo = await resolveOracleRepo(bot.bot);
  const token = await resolveToken(bot.bot, bot.tokenName);
  const defaults = discordDefaults();
  const proc = Bun.spawn(["bun", join(repo, "src", "index.ts")], {
    cwd: repo,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      ...defaultEnv(defaults),
      DISCORD_TOKEN: token,
      BOT_NAME: bot.bot,
      SERVER_URL: opts.serverUrl,
      MAW_DISCORD_SERVER_URL: opts.serverUrl,
      ORACLE_REPO: oracleRepo || undefined,
      VOICE_PROFILE:
        opts.voiceProfile ??
        bot.voiceProfile ??
        defaults.voiceProfile ??
        "premwadee",
    },
  });
  proc.unref?.();
  if (!proc.pid) throw new Error(`failed to spawn ${bot.bot}`);
  writePid(bot.bot, proc.pid);

  const registered = await waitFor(async () => {
    const record = await serverBot(opts.serverUrl, bot.bot);
    return record?.status === "online";
  });
  if (!registered) throw new Error(`${bot.bot} spawned but did not register with server`);
  log(`✓ ${bot.bot} online`);
}

async function sleepOne(
  log: (s: string) => void,
  bot: VoiceBotConfig,
  opts: VoiceCliOpts,
): Promise<void> {
  const pid = readPid(bot.bot);
  if (pid && isAlive(pid)) {
    process.kill(pid, "SIGTERM");
  }
  const offline = await waitFor(async () => {
    const record = await serverBot(opts.serverUrl, bot.bot);
    return !record || record.status !== "online";
  });
  removePid(bot.bot);
  if (!offline && pid && isAlive(pid)) {
    throw new Error(`${bot.bot} did not deregister after SIGTERM`);
  }
  log(`✓ ${bot.bot} offline`);
}

function resolveTargets(args: string[]): VoiceBotConfig[] {
  const opts = parseOpts(args);
  if (opts.all) return loadConfiguredBots();
  if (!opts.bot) throw new Error("bot name required, or pass --all");
  const configured = loadConfiguredBots().find((bot) => bot.bot === opts.bot);
  return [configured ?? { bot: opts.bot }];
}

export const cmdVoiceFleet = {
  async wake(log: (s: string) => void, args: string[]): Promise<void> {
    const opts = parseOpts(args);
    for (const bot of resolveTargets(args)) {
      await wakeOne(log, bot, opts);
    }
  },

  async sleep(log: (s: string) => void, args: string[]): Promise<void> {
    const opts = parseOpts(args);
    for (const bot of resolveTargets(args)) {
      await sleepOne(log, bot, opts);
    }
  },
};

export async function fetchServerBots(serverUrl = DEFAULT_SERVER_URL): Promise<any[]> {
  try {
    const res = await fetch(new URL("/bots", serverUrl));
    if (!res.ok) return [];
    const data = await res.json() as { bots?: any[] };
    return data.bots ?? [];
  } catch {
    return [];
  }
}
