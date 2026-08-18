// #PQ-2026-08-19 — กันบั๊ก "false-green" ของ `maw inbox status`
// อาการเดิม: resolveInboxDir() หากล่องจาก process.cwd() ชั้นเดียว ⇒ รันจากนอก repo
// (หรือจากโฟลเดอร์ย่อยของ repo เอง) โฟลเดอร์ไม่เจอ → นับ 0 → ขึ้น 🟢 "กล่องสะอาด"
// วัดอิสระ 4 บ้าน 18 ส.ค. 2026: PQ 237→0 · sombro 153→0 · slaff 57→0 · tinkle 9→0
// 🔑 ทิศที่แพงคือ 0 ไม่ใช่เลขเกิน — เลขเกินทำให้ไล่อ่านเผื่อ · 0 พร้อมไฟเขียวทำให้เลิกดู
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatInboxStatus, resolveInboxDirInfo, type InboxStatus } from "../src/vendor/mpr-plugins/inbox/impl";

const cwdBefore = process.cwd();
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-inbox-cwd-"));
  const inbox = join(root, "ψ", "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, "2026-08-18_10-00_main-tinkle_x.md"), "---\nfrom: main:tinkle\nread: false\n---\n\nhi\n");
  mkdirSync(join(root, "tools", "deep"), { recursive: true });
});

afterEach(() => {
  process.chdir(cwdBefore);
  rmSync(root, { recursive: true, force: true });
});

describe("resolveInboxDirInfo — เดินขึ้นหาบ้าน", () => {
  test("รันจาก repo root → เจอกล่อง", () => {
    process.chdir(root);
    const info = resolveInboxDirInfo();
    expect(info.found).toBe(true);
    expect(info.dir).toBe(join(root, "ψ", "inbox"));
  });

  test("รันจากโฟลเดอร์ย่อยลึก → ยังเจอกล่องเดิม (นี่คือบั๊กเดิม)", () => {
    process.chdir(join(root, "tools", "deep"));
    const info = resolveInboxDirInfo();
    expect(info.found).toBe(true);
    expect(info.dir).toBe(join(root, "ψ", "inbox"));
  });

  test("รันจากที่ที่ไม่มีกล่องเลย → found=false ห้ามเดาว่าเจอ", () => {
    const outside = mkdtempSync(join(tmpdir(), "maw-no-inbox-"));
    try {
      process.chdir(outside);
      expect(resolveInboxDirInfo().found).toBe(false);
    } finally {
      process.chdir(cwdBefore);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("formatInboxStatus — หากล่องไม่เจอต้อง ⚪ ไม่ใช่ 🟢", () => {
  const unknown: InboxStatus = {
    oracle: "pq",
    unread: 0,
    oldest_age_seconds: null,
    last_archive_age_seconds: null,
    delta_since_last_check: 0,
    level: "unknown",
    reasons: ["inbox_dir_not_found:/tmp/ψ/inbox"],
  };

  test("ไม่พิมพ์ไฟเขียว และไม่พิมพ์เลข 0 ให้อ่านผิดว่ากล่องว่าง", () => {
    const out = formatInboxStatus(unknown);
    expect(out).toContain("⚪");
    expect(out).not.toContain("🟢");
    expect(out).not.toMatch(/UNREAD 0\b/);
  });
});
