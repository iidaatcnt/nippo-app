// 問題兆候の検知ルール
// 判定ロジックは純粋関数にしてテストしやすくし、DBへの読み書きは runDetection にまとめる。

export type Severity = "low" | "mid" | "high";

export interface AlertDraft {
  tenantId: number;
  userId: number;
  kind: string;
  severity: Severity;
  detail: string;
  dedupeKey: string;
}

export interface ReportLite {
  report_date: string;
  condition: number;
  done: string;
  end_time: string | null;
}

export interface KeywordRule {
  word: string;
  severity: Severity;
}

const SEV_RANK: Record<Severity, number> = { low: 1, mid: 2, high: 3 };

// ---- 日付ユーティリティ（JST） ----

export function jstToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWeekday(date: string): boolean {
  const w = new Date(date + "T00:00:00Z").getUTCDay();
  return w !== 0 && w !== 6;
}

/** ISO週の月曜日（同じ週のアラートを1件にまとめるためのキー） */
export function weekKey(date: string): string {
  const w = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((w + 6) % 7));
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---- 個別ルール ----

/** 日報本文に含まれるキーワード（最も重いものを返す） */
export function matchKeywords(text: string, rules: KeywordRule[]): { words: string[]; severity: Severity } | null {
  const hits = rules.filter((r) => r.word && text.includes(r.word));
  if (!hits.length) return null;
  const severity = hits.reduce<Severity>((s, r) => (SEV_RANK[r.severity] > SEV_RANK[s] ? r.severity : s), "low");
  return { words: [...new Set(hits.map((h) => h.word))], severity };
}

/** 調子の低下: 直近7日平均が、その前28日平均より1.0以上低い */
export function conditionDrop(reports: ReportLite[], today: string): string | null {
  const recentFrom = addDays(today, -6);
  const baseFrom = addDays(today, -34);
  const recent = reports.filter((r) => r.report_date >= recentFrom && r.report_date <= today).map((r) => r.condition);
  const base = reports.filter((r) => r.report_date >= baseFrom && r.report_date < recentFrom).map((r) => r.condition);
  if (recent.length < 3 || base.length < 3) return null;
  const diff = avg(base) - avg(recent);
  if (diff < 1.0) return null;
  return `調子の平均が ${avg(base).toFixed(1)} → ${avg(recent).toFixed(1)} に低下しています（直近7日 vs その前4週）`;
}

/** 低調の連続: 直近3回の日報がすべて調子2以下（直近の日報が7日以内） */
export function lowStreak(reports: ReportLite[], today: string): { severity: Severity; detail: string } | null {
  const sorted = [...reports].sort((a, b) => b.report_date.localeCompare(a.report_date)).slice(0, 3);
  if (sorted.length < 3 || sorted[0].report_date < addDays(today, -7)) return null;
  if (!sorted.every((r) => r.condition <= 2)) return null;
  const severity: Severity = sorted.every((r) => r.condition === 1) ? "high" : "mid";
  return { severity, detail: `直近3回の日報で調子が低い状態（${sorted.map((r) => r.condition).join("・")}）が続いています` };
}

/** 未提出: 直近3営業日（今日を除く）すべて未提出 */
export function unsubmitted(reports: ReportLite[], today: string, userCreatedDate: string): string | null {
  const days: string[] = [];
  for (let d = addDays(today, -1); days.length < 3; d = addDays(d, -1)) if (isWeekday(d)) days.push(d);
  // 登録から間もない人は対象外
  if (userCreatedDate > days[days.length - 1]) return null;
  const submitted = new Set(reports.map((r) => r.report_date));
  if (days.some((d) => submitted.has(d))) return null;
  return `${days[days.length - 1]} 以降の3営業日、日報が提出されていません`;
}

/** 長時間労働: 今月の退勤時刻から時間外を推計し、月末時点の見込みを出す */
export function overtime(
  reports: ReportLite[],
  today: string,
  standardEnd = "17:30",
): { severity: Severity; detail: string; month: string } | null {
  const month = today.slice(0, 7);
  const these = reports.filter((r) => r.report_date.startsWith(month) && r.end_time);
  if (these.length < 3) return null;
  const totalMin = these.reduce((s, r) => s + Math.max(0, minutes(r.end_time!) - minutes(standardEnd)), 0);
  let elapsed = 0;
  let inMonth = 0;
  for (let d = month + "-01"; d.startsWith(month); d = addDays(d, 1)) {
    if (!isWeekday(d)) continue;
    inMonth++;
    if (d <= today) elapsed++;
  }
  const projectedH = (totalMin / 60 / Math.max(elapsed, 1)) * inMonth;
  if (projectedH < 45) return null;
  const severity: Severity = projectedH >= 80 ? "high" : "mid";
  return {
    severity,
    month,
    detail: `今月の時間外は約${(totalMin / 60).toFixed(1)}時間、月末見込みは約${projectedH.toFixed(0)}時間です（退勤時刻からの推計）`,
  };
}

/** 記述量の急減: 直近3回の「やったこと」が普段の3割未満 */
export function textShrink(reports: ReportLite[]): string | null {
  const sorted = [...reports].sort((a, b) => b.report_date.localeCompare(a.report_date));
  const recent = sorted.slice(0, 3);
  const prior = sorted.slice(3, 23).map((r) => r.done.length).sort((a, b) => a - b);
  if (recent.length < 3 || prior.length < 10) return null;
  const median = prior[Math.floor(prior.length / 2)];
  if (median < 20) return null;
  if (!recent.every((r) => r.done.length < median * 0.3)) return null;
  return `直近3回の日報の記述量が普段（約${median}文字）の3割未満に減っています`;
}

// ---- 夜間バッチ ----

export async function runDetection(db: D1Database, now = new Date()): Promise<number> {
  const today = jstToday(now);
  const week = weekKey(today);
  const since = addDays(today, -60);

  const tenants = await db.prepare("SELECT id, settings FROM tenants").all<{ id: number; settings: string }>();
  const drafts: AlertDraft[] = [];

  for (const t of tenants.results) {
    const settings = safeJson(t.settings);
    const users = await db
      .prepare(
        "SELECT id, name, supervisor_id, substr(created_at,1,10) AS created FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('employee','supervisor')",
      )
      .bind(t.id)
      .all<{ id: number; name: string; supervisor_id: number | null; created: string }>();
    const reportRows = await db
      .prepare("SELECT id, user_id, report_date, condition, done, end_time FROM reports WHERE tenant_id = ? AND report_date >= ?")
      .bind(t.id, since)
      .all<ReportLite & { id: number; user_id: number }>();

    for (const u of users.results) {
      const mine = reportRows.results.filter((r) => r.user_id === u.id);
      const push = (kind: string, severity: Severity, detail: string, key: string) =>
        drafts.push({ tenantId: t.id, userId: u.id, kind, severity, detail, dedupeKey: `${kind}:${u.id}:${key}` });

      const drop = conditionDrop(mine, today);
      if (drop) push("condition_drop", "mid", drop, week);
      const streak = lowStreak(mine, today);
      if (streak) push("low_streak", streak.severity, streak.detail, week);
      const miss = unsubmitted(mine, today, u.created);
      if (miss) push("unsubmitted", "low", miss, week);
      const ot = overtime(mine, today, settings.standardEnd || "17:30");
      if (ot) push("overtime", ot.severity, ot.detail, `${ot.month}:${ot.severity}`);
      const shrink = textShrink(mine);
      if (shrink) push("text_shrink", "low", shrink, week);

      // 上長の無反応: 直近7日の日報が3件以上あるのに、上長のコメントも既読もない
      if (u.supervisor_id) {
        const recentIds = mine.filter((r) => r.report_date >= addDays(today, -7)).map((r) => (r as { id: number }).id);
        if (recentIds.length >= 3) {
          const ph = recentIds.map((_, i) => `?${i + 2}`).join(",");
          const touched = await db
            .prepare(
              `SELECT (SELECT COUNT(*) FROM comments WHERE user_id = ?1 AND report_id IN (${ph}))
                    + (SELECT COUNT(*) FROM report_reads WHERE user_id = ?1 AND report_id IN (${ph})) AS n`,
            )
            .bind(u.supervisor_id, ...recentIds)
            .first<{ n: number }>();
          if (!touched?.n) push("supervisor_silence", "low", "直近7日間、上長からのコメント・既読がありません", week);
        }
      }
    }
  }

  return insertAlerts(db, drafts);
}

export async function insertAlerts(db: D1Database, drafts: AlertDraft[]): Promise<number> {
  if (!drafts.length) return 0;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO alerts (tenant_id, user_id, kind, severity, detail, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const res = await db.batch(drafts.map((d) => stmt.bind(d.tenantId, d.userId, d.kind, d.severity, d.detail, d.dedupeKey)));
  return res.reduce((n, r) => n + (r.meta.changes || 0), 0);
}

export function safeJson(s: string | null | undefined): Record<string, any> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

export const ALERT_KIND_LABEL: Record<string, string> = {
  keyword: "気になる言葉",
  consultation: "労務担当への相談",
  condition_drop: "調子の低下",
  low_streak: "低調の連続",
  unsubmitted: "未提出",
  overtime: "長時間労働",
  text_shrink: "記述量の急減",
  supervisor_silence: "上長の無反応",
};
