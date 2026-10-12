import { describe, expect, it } from "vitest";
import { conditionDrop, lowStreak, unsubmitted, overtime, textShrink, matchKeywords, weekKey, jstToday, type ReportLite } from "../src/detect";
import { hashPassword, verifyPassword } from "../src/crypto";

const rep = (report_date: string, condition: number, extra: Partial<ReportLite> = {}): ReportLite => ({
  report_date, condition, done: "通常業務を行いました。見積作成と打ち合わせ、資料の整理をしました。", end_time: null, ...extra,
});

describe("日付", () => {
  it("JSTの日付を返す", () => {
    expect(jstToday(new Date("2026-10-12T16:00:00Z"))).toBe("2026-10-13");
  });
  it("週キーは月曜日", () => {
    expect(weekKey("2026-10-14")).toBe("2026-10-12");
    expect(weekKey("2026-10-18")).toBe("2026-10-12");
  });
});

describe("キーワード", () => {
  const rules = [
    { word: "疲れた", severity: "low" as const },
    { word: "怒鳴られ", severity: "mid" as const },
    { word: "死にたい", severity: "high" as const },
  ];
  it("最も重い重要度を返す", () => {
    expect(matchKeywords("今日も怒鳴られて疲れた", rules)).toEqual({ words: ["疲れた", "怒鳴られ"], severity: "mid" });
  });
  it("一致しなければ null", () => {
    expect(matchKeywords("順調です", rules)).toBeNull();
  });
});

describe("調子の低下", () => {
  it("直近7日の平均が前4週より1以上低いと検知", () => {
    const rs = [rep("2026-09-20", 4), rep("2026-09-22", 4), rep("2026-09-25", 5), rep("2026-10-07", 2), rep("2026-10-08", 3), rep("2026-10-09", 2)];
    expect(conditionDrop(rs, "2026-10-12")).toMatch("4.3 → 2.3");
  });
  it("データが少なければ判定しない", () => {
    expect(conditionDrop([rep("2026-10-09", 1)], "2026-10-12")).toBeNull();
  });
});

describe("低調の連続", () => {
  it("3回連続で2以下なら中、すべて1なら高", () => {
    expect(lowStreak([rep("2026-10-07", 2), rep("2026-10-08", 1), rep("2026-10-09", 2)], "2026-10-12")?.severity).toBe("mid");
    expect(lowStreak([rep("2026-10-07", 1), rep("2026-10-08", 1), rep("2026-10-09", 1)], "2026-10-12")?.severity).toBe("high");
  });
  it("間に3以上があれば検知しない", () => {
    expect(lowStreak([rep("2026-10-07", 2), rep("2026-10-08", 3), rep("2026-10-09", 2)], "2026-10-12")).toBeNull();
  });
});

describe("未提出", () => {
  it("直近3営業日すべて未提出で検知（土日は数えない）", () => {
    // 2026-10-12(月) の時点: 10/9(金) 10/8(木) 10/7(水)
    expect(unsubmitted([rep("2026-10-06", 3)], "2026-10-12", "2026-09-01")).toMatch("2026-10-07");
    expect(unsubmitted([rep("2026-10-07", 3)], "2026-10-12", "2026-09-01")).toBeNull();
  });
  it("登録直後の人は対象外", () => {
    expect(unsubmitted([], "2026-10-12", "2026-10-09")).toBeNull();
  });
});

describe("長時間労働", () => {
  it("月末見込みが45時間を超えると中、80時間を超えると高", () => {
    const mid = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"].map((d) => rep(d, 3, { end_time: "20:00" }));
    expect(overtime(mid, "2026-10-07")?.severity).toBe("mid"); // 2.5h × 22日 = 55h
    const high = mid.map((r) => ({ ...r, end_time: "22:00" }));
    expect(overtime(high, "2026-10-07")?.severity).toBe("high"); // 4.5h × 22日 = 99h
  });
  it("定時退勤なら検知しない", () => {
    const rs = ["2026-10-01", "2026-10-02", "2026-10-05"].map((d) => rep(d, 3, { end_time: "17:30" }));
    expect(overtime(rs, "2026-10-05")).toBeNull();
  });
});

describe("記述量の急減", () => {
  it("直近3回が普段の3割未満なら検知", () => {
    const prior = Array.from({ length: 12 }, (_, i) => rep(`2026-09-${String(10 + i).padStart(2, "0")}`, 3));
    const recent = ["2026-10-07", "2026-10-08", "2026-10-09"].map((d) => rep(d, 3, { done: "特になし" }));
    expect(textShrink([...prior, ...recent])).not.toBeNull();
    expect(textShrink(prior)).toBeNull();
  });
});

describe("パスワード", () => {
  it("ハッシュと照合", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
  });
});
