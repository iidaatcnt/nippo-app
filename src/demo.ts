// デモデータ
// 「デモ株式会社」（社長1・上長2・社員10・労務担当1）と約2ヶ月分の日報・コメント・既読・相談・アラート・対応記録を作る。
// 日付は実行日から逆算する（最後の日報は前営業日）。夜間の兆候検知（detect.ts）を過去の日付で再現し、本番と同じ dedupe_key でアラートを作る。
// 会社の ID は 9000、登場人物は 9001〜9030 に固定しているので、DEMO_CLEAR_SQL で丸ごと消せる。

import { addDays, isWeekday, weekKey, matchKeywords, conditionDrop, lowStreak, unsubmitted, overtime, textShrink, type ReportLite, type KeywordRule } from "./detect";

export const DEMO_TENANT_ID = 9000;
const TENANT = DEMO_TENANT_ID;
const WORKDAYS = 43; // 約2ヶ月

// デモの登場人物（ID 固定）。本番の利用者は AUTOINCREMENT で採番されるので、デモを一度入れた後はこの範囲と重ならない。
const DEMO_USER_IDS = "9001,9002,9003,9011,9012,9013,9014,9015,9016,9017,9018,9019,9020,9030";

export const DEMO_CLEAR_SQL = [
  `DELETE FROM status_history WHERE user_id IN (${DEMO_USER_IDS})`,
  `DELETE FROM employee_status WHERE user_id IN (${DEMO_USER_IDS})`,
  "DELETE FROM alert_notes WHERE alert_id IN (SELECT id FROM alerts WHERE tenant_id = 9000)",
  "DELETE FROM alerts WHERE tenant_id = 9000",
  "DELETE FROM consultations WHERE tenant_id = 9000",
  "DELETE FROM report_reads WHERE report_id IN (SELECT id FROM reports WHERE tenant_id = 9000)",
  "DELETE FROM comments WHERE report_id IN (SELECT id FROM reports WHERE tenant_id = 9000)",
  "DELETE FROM reports WHERE tenant_id = 9000",
  "DELETE FROM labor_assignments WHERE tenant_id = 9000",
  `DELETE FROM sessions WHERE user_id IN (${DEMO_USER_IDS})`,
  `DELETE FROM invites WHERE user_id IN (${DEMO_USER_IDS})`,
  "DELETE FROM keyword_rules WHERE tenant_id = 9000",
  `DELETE FROM users WHERE id IN (${DEMO_USER_IDS})`,
  "DELETE FROM tenants WHERE id = 9000",
];

/** 日報・コメントなどの ID の開始位置（既存データの最大 ID の次から振る） */
export interface DemoIdBase {
  report: number;
  comment: number;
  alert: number;
  note: number;
  history: number;
  consultation: number;
}

export const DEMO_ID_BASE_SQL = `SELECT
  (SELECT COALESCE(MAX(id), 0) FROM reports) AS report,
  (SELECT COALESCE(MAX(id), 0) FROM comments) AS comment,
  (SELECT COALESCE(MAX(id), 0) FROM alerts) AS alert,
  (SELECT COALESCE(MAX(id), 0) FROM alert_notes) AS note,
  (SELECT COALESCE(MAX(id), 0) FROM status_history) AS history,
  (SELECT COALESCE(MAX(id), 0) FROM consultations) AS consultation`;

// ---- 乱数（毎回同じ筋書きになるよう固定シード） ----
let seed = 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));
const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
// JST の日時 → D1 に保存している UTC の "YYYY-MM-DD HH:MM:SS"
const utc = (date: string, jstHHMM: string) => new Date(`${date}T${jstHHMM}:00+09:00`).toISOString().replace("T", " ").slice(0, 19);
const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---- 登場人物 ----
type Dept = "sales" | "ops";
interface Person { id: number; name: string; email: string; role: "owner" | "supervisor" | "employee" | "labor"; dept?: Dept; sup?: number; story?: string }
const P: Person[] = [
  { id: 9001, name: "山田 太郎", email: "demo-owner@example.com", role: "owner" },
  { id: 9002, name: "木村 剛", email: "demo-kimura@example.com", role: "supervisor", dept: "sales", story: "manager" },
  { id: 9003, name: "林 恵子", email: "demo-hayashi@example.com", role: "supervisor", dept: "ops", story: "manager" },
  { id: 9011, name: "佐藤 健太", email: "demo-sato@example.com", role: "employee", dept: "sales", sup: 9002, story: "steady_high" },
  { id: 9012, name: "鈴木 美咲", email: "demo-suzuki@example.com", role: "employee", dept: "sales", sup: 9002, story: "harassment" },
  { id: 9013, name: "高橋 翔", email: "demo-takahashi@example.com", role: "employee", dept: "sales", sup: 9002, story: "overtime" },
  { id: 9014, name: "田中 由美", email: "demo-tanaka@example.com", role: "employee", dept: "sales", sup: 9002, story: "steady" },
  { id: 9015, name: "伊藤 大輔", email: "demo-ito@example.com", role: "employee", dept: "sales", sup: 9002, story: "shrink" },
  { id: 9016, name: "渡辺 さくら", email: "demo-watanabe@example.com", role: "employee", dept: "ops", sup: 9003, story: "rookie" },
  { id: 9017, name: "山本 拓也", email: "demo-yamamoto@example.com", role: "employee", dept: "ops", sup: 9003, story: "fading" },
  { id: 9018, name: "中村 優子", email: "demo-nakamura@example.com", role: "employee", dept: "ops", sup: 9003, story: "dip_recover" },
  { id: 9019, name: "小林 誠", email: "demo-kobayashi@example.com", role: "employee", dept: "ops", sup: 9003, story: "steady" },
  { id: 9020, name: "加藤 愛", email: "demo-kato@example.com", role: "employee", dept: "ops", sup: 9003, story: "busy_tired" },
  { id: 9030, name: "労務 花子（リライエ）", email: "demo-labor@example.com", role: "labor" },
];
const byId = new Map(P.map((p) => [p.id, p]));
const LABOR = 9030;

// ---- 文章の部品 ----
const CLIENTS = ["丸山商事", "北斗建設", "青葉フーズ", "さくら薬局", "東和精機", "みどり保育園", "大川運輸", "星野製作所"];
const DONE: Record<Dept, (() => string)[]> = {
  sales: [
    () => `${pick(CLIENTS)}様を訪問し、新サービスの提案をしました。担当者の反応は前向きで、来週見積を出します。`,
    () => `${pick(CLIENTS)}様の見積書を作成し、課長の確認を受けて送付しました。`,
    () => `既存顧客${2 + Math.floor(rand() * 4)}件に電話でフォロー。${pick(CLIENTS)}様から追加の相談をいただきました。`,
    () => `午前は社内の営業会議、午後は${pick(CLIENTS)}様と打ち合わせ。納期について調整しました。`,
    () => `提案書の作り直し。${pick(CLIENTS)}様向けに価格表と導入事例を追加しました。`,
  ],
  ops: [
    () => `受注データ${10 + Math.floor(rand() * 30)}件の入力と出荷手配を行いました。`,
    () => `請求書の発行と入金確認。${pick(CLIENTS)}様の入金漏れを見つけて営業に共有しました。`,
    () => `在庫の棚卸しと発注。欠品しそうな品目を${2 + Math.floor(rand() * 4)}件洗い出しました。`,
    () => `電話・メール対応が中心。${pick(CLIENTS)}様からの問い合わせに回答しました。`,
    () => `業務マニュアルの更新。新しい受注フローを図にまとめました。`,
  ],
};
const REDO = [
  "朝のうちに優先順位を決めてから動けばよかった。",
  "資料の確認をもう一度してから送ればよかった。",
  "分からないところを早めに聞けばよかった。",
  "移動時間にメールを片付けておけばよかった。",
  "打ち合わせの前に相手の状況をもっと調べておけばよかった。",
  "",
];
const GROWTH = [
  "相手の話を最後まで聞くと、こちらの提案が通りやすいと感じた。",
  "チェックリストを使うとミスが減ることが分かった。",
  "先輩のやり方を真似したら作業時間が半分になった。",
  "お客様の「ありがとう」が励みになった。",
  "数字で説明すると社内でも話が早い。",
  "",
];
const PLAN: Record<Dept, string[]> = {
  sales: ["見積の送付と訪問2件", "提案書の仕上げ", "新規リストへの電話", "既存顧客のフォロー", "月次の売上集計"],
  ops: ["請求書の締め作業", "出荷手配と在庫確認", "マニュアルの続き", "問い合わせ対応", "月末の締め準備"],
};
const COMMENTS = [
  "お疲れさまでした。いい動きですね。",
  "その気づきは大事です。チームにも共有してください。",
  "明日の訪問、何かあれば相談してください。",
  "数字の裏付けがあって分かりやすいです。",
  "無理しすぎないように。困ったら早めに声をかけてください。",
  "ありがとう、助かりました。",
];
const REPLIES = ["ありがとうございます！", "承知しました。明日やってみます。", "はい、相談させてください。"];
const KEYWORDS: KeywordRule[] = [
  ["死にたい", "high"], ["消えたい", "high"], ["自殺", "high"], ["殴られ", "high"], ["セクハラ", "high"], ["パワハラ", "high"], ["ハラスメント", "high"],
  ["怒鳴られ", "mid"], ["無視され", "mid"], ["人格否定", "mid"], ["辞めたい", "mid"], ["眠れない", "mid"], ["限界", "mid"],
  ["つらい", "low"], ["しんどい", "low"], ["疲れた", "low"], ["休めない", "low"],
].map(([word, severity]) => ({ word, severity }) as KeywordRule);

interface Rep extends ReportLite { id: number; user: number; redo: string; growth: string; plan: string; created: string }
interface Alert { id: number; user: number; kind: string; severity: string; detail: string; key: string; created: string }

/** デモデータを入れる SQL 文の一覧。today は JST の今日（YYYY-MM-DD）。 */
export function buildDemoSql(today: string, passwordHash: string | null, base: DemoIdBase): string[] {
  seed = 20261012;

  // 営業日（土日以外）。workdays[0] が最古、末尾が前営業日。ago(n) は前営業日から n 営業日前。
  const workdays: string[] = [];
  for (let d = addDays(today, -1); workdays.length < WORKDAYS; d = addDays(d, -1)) if (isWeekday(d)) workdays.unshift(d);
  const ago = (n: number) => workdays[workdays.length - 1 - n];
  const created = utc(addDays(workdays[0], -10), "09:00");

  // ---- 1日分の日報を筋書きに沿って作る ----
  const makeReport = (p: Person, date: string, i: number): Omit<Rep, "id" | "user" | "created"> | null => {
    const dept = p.dept!;
    const t = i / workdays.length; // 0→1 で期間の進み具合
    let cond = 3.6 + (rand() - 0.5) * 1.6;
    let done = pick(DONE[dept])();
    let redo = pick(REDO);
    let growth = pick(GROWTH);
    let end = 17 * 60 + 30 + Math.floor(rand() * 60); // 17:30〜18:30
    if (chance(0.04)) return null; // たまに出し忘れ

    switch (p.story) {
      case "manager":
        done = dept === "sales" ? `営業会議と案件の進捗確認。${pick(CLIENTS)}様に同行しました。` : `チームの業務分担を見直し、請求の締めを確認しました。`;
        redo = "";
        growth = "";
        end += 30;
        break;
      case "steady_high":
        cond += 0.6;
        if (chance(0.3)) growth = "今月の目標に対して順調。後輩にも声をかけていきたい。";
        break;
      case "harassment":
        // 1ヶ月ほど前から調子が落ち、課長とのやりとりで悩む
        if (date >= ago(19)) {
          cond = date >= ago(9) ? 1.5 + (rand() - 0.5) : 2.0 + (rand() - 0.5) * 1.2;
          if (date === ago(17)) redo = "会議で数字の説明がうまくできず、みんなの前で怒鳴られてしまった。準備不足だった。";
          else if (date === ago(10)) growth = "最近、夜あまり眠れない。仕事のことを考えてしまう。";
          else if (date === ago(5)) redo = "報告に行ったら無視されたように感じた。タイミングが悪かったのかもしれない。";
          else if (chance(0.5)) {
            redo = "";
            growth = "";
          }
          done = done.split("。")[0] + "。";
        }
        break;
      case "overtime":
        // 繁忙期から残業が増え続ける
        if (date >= ago(28)) end = 20 * 60 + Math.floor(rand() * 120);
        if (date >= ago(9)) end = 21 * 60 + Math.floor(rand() * 90);
        if (date >= ago(14)) cond -= 0.7;
        if (date >= ago(9) && chance(0.3)) growth = "案件が重なっていて正直しんどい。でも今が踏ん張りどき。";
        break;
      case "shrink":
        // 最近になって記述が極端に短くなる
        if (date >= ago(7)) {
          done = pick(["特になし", "通常業務", "訪問", "事務作業"]);
          redo = "";
          growth = "";
          cond -= 0.5;
        }
        break;
      case "rookie":
        cond += 0.3 + t * 0.4;
        growth = pick(["初めて一人で請求の締めができた！", "電話対応に少し慣れてきた。", "林さんに教わったショートカットが便利。", growth]);
        break;
      case "fading":
        // 2週間ほど前から調子が落ち、ここ数日は日報が止まる
        if (date >= ago(11)) cond -= 1.2;
        if (date === ago(6)) growth = "最近眠れない日が多い。朝がつらい。";
        if (date >= ago(3)) return null;
        break;
      case "dip_recover":
        // 期間の前半に一時的に落ち込み、面談後に回復
        if (date >= ago(34) && date <= ago(25)) cond = 2 + (rand() - 0.5);
        if (date === ago(31)) growth = "家のことでバタバタしていて、少しつらい時期です。";
        break;
      case "busy_tired":
        if (["28", "29", "30", "31", "01"].includes(date.slice(8))) {
          end += 90;
          cond -= 0.8;
          if (chance(0.6)) growth = "月末で疲れた。でも締めは間に合った。";
        }
        break;
    }
    return { report_date: date, condition: clamp(cond), done, redo, growth, plan: pick(PLAN[dept]), end_time: hm(Math.min(end, 23 * 60 + 30)) };
  };

  // ---- 日報・コメント・既読 ----
  const reports: Rep[] = [];
  const comments: { id: number; report: number; user: number; kind: "comment" | "like"; body: string; created: string }[] = [];
  const reads: { report: number; user: number; at: string }[] = [];
  let rid = base.report;
  let cid = base.comment;
  const writers = P.filter((p) => p.role === "employee" || p.role === "supervisor");
  workdays.forEach((date, i) => {
    for (const p of writers) {
      const r = makeReport(p, date, i);
      if (!r) continue;
      const id = ++rid;
      reports.push({ ...r, id, user: p.id, created: utc(date, r.end_time ?? "18:00") });
      if (!p.sup) continue;
      // 上長の反応。鈴木さんへの木村課長の反応は途中から途絶える
      const silent = p.story === "harassment" && date >= ago(15);
      const next = addDays(date, 1);
      if (!silent && chance(0.85)) reads.push({ report: id, user: p.sup, at: utc(next, "09:10") });
      if (!silent && chance(0.35)) {
        const body = p.story === "overtime" && date >= ago(18) ? "遅くまでお疲れさま。業務量は一度一緒に見直しましょう。" : pick(COMMENTS);
        comments.push({ id: ++cid, report: id, user: p.sup, kind: "comment", body, created: utc(next, "09:30") });
        if (chance(0.4)) comments.push({ id: ++cid, report: id, user: p.id, kind: "comment", body: pick(REPLIES), created: utc(next, "12:15") });
      } else if (!silent && chance(0.3)) {
        comments.push({ id: ++cid, report: id, user: p.sup, kind: "like", body: "", created: utc(next, "09:20") });
      }
      if (chance(0.08)) comments.push({ id: ++cid, report: id, user: 9001, kind: "like", body: "", created: utc(next, "19:00") });
    }
  });

  // 鈴木さんから労務担当への相談（上長・社長には見えない）
  const suzukiRep = reports.find((r) => r.user === 9012 && r.report_date === ago(5))!;
  const consultations = [
    {
      id: base.consultation + 1, user: 9012, report: suzukiRep.id, created: suzukiRep.created,
      body: "木村課長との関係で悩んでいます。会議で強く叱責されることが続いていて、最近は話しかけるのも怖いです。会社に知られずに一度相談できますか。",
    },
  ];

  // ---- アラート: 提出時の即時検知 ＋ 夜間検知を日ごとに再現 ----
  const alerts = new Map<string, Omit<Alert, "id">>();
  const add = (a: Omit<Alert, "id">) => {
    if (!alerts.has(a.key)) alerts.set(a.key, a);
  };
  for (const r of reports) {
    const hit = matchKeywords([r.done, r.redo, r.growth, r.plan].join("\n"), KEYWORDS);
    if (hit) add({ user: r.user, kind: "keyword", severity: hit.severity, detail: `${r.report_date} の日報に「${hit.words.join("」「")}」が含まれています`, key: `keyword:${r.id}:${hit.words.join(",")}`, created: r.created });
  }
  for (const c of consultations) {
    const cHit = matchKeywords(c.body, KEYWORDS);
    add({ user: c.user, kind: "consultation", severity: cHit?.severity === "high" ? "high" : "mid", detail: `労務担当への相談が届きました${cHit ? `（「${cHit.words.join("」「")}」を含む）` : ""}`, key: `consultation:${c.id}`, created: c.created });
  }
  const touched = new Set([...comments.map((c) => `${c.report}:${c.user}`), ...reads.map((r) => `${r.report}:${r.user}`)]);
  for (let day = addDays(workdays[0], 14); day <= today; day = addDays(day, 1)) {
    const week = weekKey(day);
    const at = utc(day, "02:00");
    for (const p of writers) {
      const mine = reports.filter((r) => r.user === p.id && r.report_date < day);
      const push = (kind: string, severity: string, detail: string, key: string) => add({ user: p.id, kind, severity, detail, key: `${kind}:${p.id}:${key}`, created: at });
      const drop = conditionDrop(mine, day);
      if (drop) push("condition_drop", "mid", drop, week);
      const streak = lowStreak(mine, day);
      if (streak) push("low_streak", streak.severity, streak.detail, week);
      const miss = unsubmitted(mine, day, created.slice(0, 10));
      if (miss) push("unsubmitted", "low", miss, week);
      const ot = overtime(mine, day, "17:30");
      if (ot) push("overtime", ot.severity, ot.detail, `${ot.month}:${ot.severity}`);
      const shrink = textShrink(mine);
      if (shrink) push("text_shrink", "low", shrink, week);
      if (p.sup) {
        const recent = mine.filter((r) => r.report_date >= addDays(day, -7));
        if (recent.length >= 3 && !recent.some((r) => touched.has(`${r.id}:${p.sup}`)))
          push("supervisor_silence", "low", "直近7日間、上長からのコメント・既読がありません", week);
      }
    }
  }
  let aid = base.alert;
  const alertList: Alert[] = [...alerts.values()].sort((a, b) => a.created.localeCompare(b.created)).map((a) => ({ ...a, id: ++aid }));

  // ---- 労務担当の対応状況（筋書きに合わせる） ----
  const statusOf = (a: Alert): string => {
    const story = P.find((p) => p.id === a.user)!.story;
    const age = (Date.parse(today) - Date.parse(a.created.slice(0, 10))) / 86400_000;
    if (story === "harassment") return a.created >= utc(ago(6), "00:00") ? "in_progress" : "meeting";
    if (story === "overtime") return a.severity === "high" ? "checking" : "in_progress";
    if (story === "fading") return age > 7 ? "checking" : "new";
    return age > 14 ? "closed" : "new";
  };
  const firstOf = (user: number, kind?: string) => alertList.find((a) => a.user === user && (!kind || a.kind === kind));
  const notes: { alert: number; body: string; created: string }[] = [];
  const note = (a: Alert | undefined, body: string, date: string, time = "10:00") => {
    if (a && utc(date, time) >= a.created) notes.push({ alert: a.id, body, created: utc(date, time) });
  };
  note(firstOf(9012), "日報の記述から上長との関係に不安がある様子。まずは本人と面談を設定する。", ago(16));
  note(firstOf(9012, "consultation"), "本人から相談あり。課長には伝えないでほしいとの希望。社外で面談を設定。", ago(5), "17:30");
  note(firstOf(9012, "consultation"), "面談実施。会議での叱責が週2〜3回あるとのこと。パワハラ該当性を確認するため、同席者へのヒアリングを社長と調整する。", ago(3), "16:00");
  note(firstOf(9013, "overtime"), "繁忙期で案件が集中。上長と業務の再配分を相談するよう助言。36協定の上限も確認。", ago(18));
  note(firstOf(9018), "面談済み。家族の介護で一時的に負担が増えていた。時差出勤を提案し、本人も了承。", ago(28));
  note(firstOf(9017), "林課長に様子を聞く。最近元気がないとのこと。来週面談を予定。", ago(2));

  // ---- 社員ステータスと変更履歴 ----
  const STATUS: [number, string, string][] = [
    [9012, "handling", "上長とのトラブルについて相談対応中"],
    [9013, "follow", "長時間労働。業務の再配分を調整中"],
    [9017, "watch", "調子の低下と未提出。面談予定"],
    [9015, "watch", "日報の記述が急に短くなった"],
    [9018, "good", "一時的な不調は解消"],
  ];
  const HISTORY: [number, string | null, string, string, string][] = [
    [9018, null, "follow", "家庭の事情で一時的に不調", ago(30)],
    [9018, "follow", "good", "時差出勤で回復", ago(15)],
    [9012, null, "watch", "日報に気になる記述", ago(16)],
    [9012, "watch", "follow", "調子の低下が続く", ago(8)],
    [9012, "follow", "handling", "本人から相談あり", ago(5)],
    [9013, null, "follow", "月末見込みで時間外45時間超", ago(18)],
    [9017, null, "watch", "調子の低下", ago(2)],
    [9015, null, "watch", "記述量の急減", ago(1)],
  ];

  // ---- SQL ----
  const sql: string[] = [];
  sql.push(`INSERT INTO tenants (id, name, settings, created_at) VALUES (${TENANT}, 'デモ株式会社', '{"showEndTime":true,"showKK":false,"standardEnd":"17:30"}', ${q(created)});`);
  sql.push(`INSERT INTO users (id, tenant_id, email, name, role, supervisor_id, password_hash, consented_at, created_at) VALUES\n` +
    P.map((p) => `(${p.id}, ${p.role === "labor" ? "NULL" : TENANT}, ${q(p.email)}, ${q(p.name)}, '${p.role}', ${p.sup ?? "NULL"}, ${q(passwordHash)}, ${q(created)}, ${q(created)})`).join(",\n") + ";");
  sql.push(`INSERT INTO labor_assignments (user_id, tenant_id) VALUES (${LABOR}, ${TENANT});`);
  for (const c of chunk(reports, 100))
    sql.push(`INSERT INTO reports (id, user_id, tenant_id, report_date, condition, done, redo, growth, plan, end_time, created_at, updated_at) VALUES\n` +
      c.map((r) => `(${r.id}, ${r.user}, ${TENANT}, ${q(r.report_date)}, ${r.condition}, ${q(r.done)}, ${q(r.redo)}, ${q(r.growth)}, ${q(r.plan)}, ${q(r.end_time)}, ${q(r.created)}, ${q(r.created)})`).join(",\n") + ";");
  for (const c of chunk(comments, 200))
    sql.push(`INSERT INTO comments (id, report_id, user_id, kind, body, created_at) VALUES\n` + c.map((x) => `(${x.id}, ${x.report}, ${x.user}, '${x.kind}', ${q(x.body)}, ${q(x.created)})`).join(",\n") + ";");
  for (const c of chunk(reads, 400))
    sql.push(`INSERT INTO report_reads (report_id, user_id, read_at) VALUES\n` + c.map((x) => `(${x.report}, ${x.user}, ${q(x.at)})`).join(",\n") + ";");
  for (const c of consultations)
    sql.push(`INSERT INTO consultations (id, user_id, tenant_id, report_id, body, created_at) VALUES (${c.id}, ${c.user}, ${TENANT}, ${c.report}, ${q(c.body)}, ${q(c.created)});`);
  for (const c of chunk(alertList, 100))
    sql.push(`INSERT INTO alerts (id, tenant_id, user_id, kind, severity, detail, dedupe_key, status, created_at, updated_at) VALUES\n` +
      c.map((a) => `(${a.id}, ${TENANT}, ${a.user}, '${a.kind}', '${a.severity}', ${q(a.detail)}, ${q(a.key)}, '${statusOf(a)}', ${q(a.created)}, ${q(a.created)})`).join(",\n") + ";");
  if (notes.length)
    sql.push(`INSERT INTO alert_notes (id, alert_id, user_id, body, created_at) VALUES\n` +
      notes.map((n, i) => `(${base.note + 1 + i}, ${n.alert}, ${LABOR}, ${q(n.body)}, ${q(n.created)})`).join(",\n") + ";");
  sql.push(`INSERT INTO employee_status (user_id, status, note, updated_by, updated_at) VALUES\n` +
    STATUS.map(([user, st, n]) => `(${user}, '${st}', ${q(n)}, ${LABOR}, ${q(utc(HISTORY.filter((h) => h[0] === user).at(-1)?.[4] ?? ago(1), "11:00"))})`).join(",\n") + ";");
  sql.push(`INSERT INTO status_history (id, user_id, old_status, new_status, note, changed_by, created_at) VALUES\n` +
    HISTORY.map(([user, from, to, n, date], i) => `(${base.history + 1 + i}, ${user}, ${q(from)}, '${to}', ${q(n)}, ${LABOR}, ${q(utc(date, "11:00"))})`).join(",\n") + ";");
  return sql;
}
