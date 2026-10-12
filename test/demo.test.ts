import { describe, expect, it } from "vitest";
import { buildDemoSql } from "../src/demo";

const base = { report: 0, comment: 0, alert: 0, note: 0, history: 0, consultation: 0 };

describe("デモデータ", () => {
  const sql = buildDemoSql("2026-10-13", null, base).join("\n");
  it("筋書きどおりのアラートが含まれる", () => {
    expect(sql).toContain("怒鳴られ");
    expect(sql).toContain("'consultation'");
    expect(sql).toContain("'overtime', 'high'");
    expect(sql).toContain("'unsubmitted'");
    expect(sql).toContain("'text_shrink'");
    expect(sql).toContain("'supervisor_silence'");
  });
  it("前営業日までの日報を作る", () => {
    expect(sql).toContain("'2026-10-12'");
    expect(sql).not.toContain("'2026-10-13', ");
  });
  it("同じ日付なら同じデータになる", () => {
    expect(buildDemoSql("2026-10-13", null, base).join("\n")).toBe(sql);
  });
});
