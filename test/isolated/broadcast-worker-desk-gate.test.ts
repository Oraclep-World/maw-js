/**
 * ด่านกัน "ใบไม่จ่าหน้า" เข้าโต๊ะคนงาน (7 ส.ค. 2026 — พลีมเคาะ "ทำด่านจริง เอาที่กันได้จริง")
 *
 * เหตุจริง: `maw broadcast` แบบไม่ scope ตกลง pane codex ทั้ง 5 ห้องของโต๊ะ 90-family-codex
 * ⇒ 2026-08-06T18:05Z (= 7 ส.ค. 01:05 +07) ทั้ง 5 ห้องตอบใบประชุมใบเดียวกัน ห่างกัน 14 วินาที
 * ⇒ 31 ก.ค. รอบแรก: ค้าง composer ทั้ง 5 ห้อง
 * FLEET-PLAYBOOK.md กฎเหล็กข้อ 3 เขียนอาการ+ของแก้ไว้ครบตั้งแต่ 31 ก.ค. แล้วยังเกิดซ้ำใน 6 วัน
 * ⇒ เทสชุดนี้ต้องพิสูจน์ว่า "กันได้จริง" ไม่ใช่ "มีข้อความเตือน"
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

let paneCommands = new Map<string, string>();
let sessionOptions = new Map<string, string>();
let paneIds = new Map<string, string>();
let sessions: Array<{ name: string; windows: Array<{ index: number; name: string }> }> = [];
let sendCalls: Array<{ target: string; text: string }> = [];
let logs: string[] = [];
let originalLog: typeof console.log;

mock.module("maw-js/sdk", () => ({
  hostExec: async () => "",
  listSessions: async () => [],
  tmuxCmd: () => "tmux",
  isAgentCommand: (cmd: string | null | undefined) => /claude|codex|node/i.test((cmd ?? "").trim()),
  loadOracleRegistry: () => null,
  loadFleetEntries: () => [],
  tmux: {
    run: async (subcommand: string, ...args: string[]) => {
      if (subcommand === "show-options") {
        const name = args[args.indexOf("-t") + 1]!;
        return (sessionOptions.get(name) ?? "") + "\n";
      }
      if (subcommand === "display-message") {
        if (args.length === 2 && args[0] === "-p" && args[1] === "#{window_name}") return "sender-pane\n";
        if (args.includes("-t")) {
          const target = args[args.indexOf("-t") + 1]!;
          const cmd = paneCommands.get(target) ?? "zsh";
          const fmt = args[args.indexOf("-p") + 1] ?? "";
          if (fmt.includes("#{pane_id}") && paneIds.has(target)) return `${paneIds.get(target)}\t${cmd}\n`;
          return cmd + "\n";
        }
      }
      return "";
    },
    listAll: async () => sessions,
    sendText: async (target: string, text: string) => { sendCalls.push({ target, text }); },
  },
}));

const { cmdBroadcast, parseBroadcastArgs, NO_BROADCAST_OPTION } =
  await import("../../src/vendor/mpr-plugins/broadcast/impl");

beforeEach(() => {
  // โต๊ะ codex 5 ห้อง (ของจริง) + บ้าน oracle ปกติ 1 บ้าน
  sessions = [
    { name: "90-family-codex", windows: [1, 2, 3, 4, 5].map(i => ({ index: i, name: `codex-${i}` })) },
    { name: "09-ferris", windows: [{ index: 0, name: "ferris" }] },
  ];
  paneCommands = new Map([
    ...[1, 2, 3, 4, 5].map(i => [`90-family-codex:${i}`, "codex"] as [string, string]),
    ["09-ferris:0", "claude"] as [string, string],
  ]);
  sessionOptions = new Map();
  paneIds = new Map();
  sendCalls = [];
  logs = [];
  originalLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
});

afterEach(() => { console.log = originalLog; });

const targets = () => sendCalls.map(c => c.target);

describe("ด่าน @maw-no-broadcast", () => {
  test("🔴 ก่อนตั้งด่าน — ใบไม่จ่าหน้าตกลงห้อง codex ครบทั้ง 5 (นี่คืออาการที่เกิดจริง 6 ส.ค.)", async () => {
    await cmdBroadcast("ใบประชุมฟลีต");
    expect(targets()).toEqual([
      "90-family-codex:1", "90-family-codex:2", "90-family-codex:3",
      "90-family-codex:4", "90-family-codex:5", "09-ferris:0",
    ]);
  });

  test("✅ ตั้งด่านแล้ว — ใบไม่จ่าหน้าไม่ถึง codex สักห้อง แต่บ้านอื่นยังได้รับครบ", async () => {
    sessionOptions.set("90-family-codex", "1");
    await cmdBroadcast("ใบประชุมฟลีต");
    expect(targets()).toEqual(["09-ferris:0"]);
    expect(sendCalls.some(c => c.target.startsWith("90-family-codex"))).toBe(false);
  });

  test("✅ จ่าหน้าถึงโต๊ะตรงๆ ด้วย --session ยังส่งได้ (ด่านกันเฉพาะใบไม่จ่าหน้า)", async () => {
    sessionOptions.set("90-family-codex", "1");
    await cmdBroadcast("งานของโต๊ะ", { session: "90-family-codex" });
    expect(targets()).toEqual([
      "90-family-codex:1", "90-family-codex:2", "90-family-codex:3",
      "90-family-codex:4", "90-family-codex:5",
    ]);
  });

  test("✅ --fleet ที่กวาดโดนโต๊ะ ยังถูกกัน — เฉพาะ --session เท่านั้นที่นับว่าจ่าหน้า", async () => {
    sessionOptions.set("90-family-codex", "1");
    await cmdBroadcast("ใบกลาง", { fleet: "all" });
    expect(sendCalls.some(c => c.target.startsWith("90-family-codex"))).toBe(false);
  });

  test("✅ ผู้ส่งต้องเห็นว่าถูกกัน + เห็นวิธีส่งจริง (ด่านที่เงียบ = ด่านที่ไม่มีใครรู้)", async () => {
    sessionOptions.set("90-family-codex", "1");
    await cmdBroadcast("ใบประชุมฟลีต");
    const out = logs.join("\n");
    expect(out).toContain(NO_BROADCAST_OPTION);
    expect(out).toContain("--session 90-family-codex");
    expect(out).toContain("5 skipped");
  });

  test("✅ ค่าที่ไม่ใช่การเปิด (0/ว่าง/ขยะ) ต้องไม่กันใบปกติหาย", async () => {
    for (const v of ["", "0", "false", "off", "ไม่รู้"]) {
      sendCalls = [];
      sessionOptions.set("90-family-codex", v);
      await cmdBroadcast("ใบปกติ");
      expect(targets().length).toBe(6);
    }
  });

  test("✅ อ่าน option ไม่ได้ (tmux โยน error) = ส่งตามปกติ ไม่ใช่กันทุกอย่าง (fail-open โดยตั้งใจ)", async () => {
    const { tmux } = await import("maw-js/sdk") as { tmux: { run: (s: string, ...a: string[]) => Promise<string> } };
    const orig = tmux.run;
    tmux.run = async (sub: string, ...args: string[]) => {
      if (sub === "show-options") throw new Error("tmux: no server running");
      return orig(sub, ...args);
    };
    try {
      await cmdBroadcast("ใบปกติ");
      expect(targets().length).toBe(6);
    } finally { tmux.run = orig; }
  });
});

describe("--dry-run (ดูก่อนส่ง)", () => {
  test("parse ธง --dry-run ได้ และไม่กลืนเข้าไปในข้อความ", () => {
    const r = parseBroadcastArgs(["--dry-run", "สวัสดี", "ทุกบ้าน"]);
    expect(r.scope.dryRun).toBe(true);
    expect(r.message).toBe("สวัสดี ทุกบ้าน");
  });

  test("--dry-run ต้องไม่ส่งอะไรเลยสักตัว แต่บอกว่าจะส่งไปไหนบ้าง", async () => {
    await cmdBroadcast("ลองดู", { dryRun: true });
    expect(sendCalls).toEqual([]);
    const out = logs.join("\n");
    expect(out).toContain("DRY-RUN");
    expect(out).toContain("would send");
    expect(out).toContain("90-family-codex:codex-1");
  });
});

describe("ด่านกันส่งซ้ำใส่ pane เดิม (linked window)", () => {
  test("🔴 อาการจริงบนเครื่อง main 7 ส.ค.: pane เดียวโผล่ 3 ชื่อ ⇒ ถ้าไม่กัน จะได้ข้อความ 3 รอบ", async () => {
    // codex pane ตัวเดียวกัน ถูก link ไว้ใน 3 session (โต๊ะจริง + จอดู)
    sessions = [
      { name: "90-family-codex", windows: [{ index: 1, name: "codex-1" }] },
      { name: "08-PQ",           windows: [{ index: 1, name: "codex-1" }] },
      { name: "fam-view-1",      windows: [{ index: 1, name: "codex-1" }] },
    ];
    paneCommands = new Map([
      ["90-family-codex:1", "codex"], ["08-PQ:1", "codex"], ["fam-view-1:1", "codex"],
    ]);
    paneIds = new Map([
      ["90-family-codex:1", "%42"], ["08-PQ:1", "%42"], ["fam-view-1:1", "%42"],
    ]);
    await cmdBroadcast("ใบเดียว");
    expect(sendCalls.length).toBe(1);
    expect(logs.join("\n")).toContain("duplicate-pane");
  });

  test("✅ pane คนละตัวที่รันคำสั่งเดียวกัน ต้องได้รับครบ ไม่ถูก dedupe ทิ้ง", async () => {
    paneIds = new Map([
      ["90-family-codex:1", "%1"], ["90-family-codex:2", "%2"], ["90-family-codex:3", "%3"],
      ["90-family-codex:4", "%4"], ["90-family-codex:5", "%5"], ["09-ferris:0", "%9"],
    ]);
    await cmdBroadcast("ใบปกติ");
    expect(sendCalls.length).toBe(6);
  });

  test("✅ tmux ไม่คืน pane_id (รุ่นเก่า/mock) = ส่งครบตามเดิม ไม่ dedupe มั่ว", async () => {
    paneIds = new Map(); // ไม่มี pane_id เลย
    await cmdBroadcast("ใบปกติ");
    expect(sendCalls.length).toBe(6);
  });
});
