import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { hashPassword, verifyPassword, randomToken, sha256 } from "./crypto";
import { runDetection, insertAlerts, matchKeywords, jstToday, addDays, safeJson, type KeywordRule, type AlertDraft } from "./detect";
import { buildDemoSql, DEMO_CLEAR_SQL, DEMO_ID_BASE_SQL, DEMO_TENANT_ID, type DemoIdBase } from "./demo";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  SETUP_TOKEN?: string;
};

type Role = "employee" | "supervisor" | "owner" | "labor" | "sysadmin";

interface Me {
  id: number;
  tenant_id: number | null;
  email: string;
  name: string;
  role: Role;
  supervisor_id: number | null;
  consented_at: string | null;
}

type C = Context<{ Bindings: Env; Variables: { me: Me } }>;

const app = new Hono<{ Bindings: Env; Variables: { me: Me } }>().basePath("/api");

const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "サーバーでエラーが発生しました" }, 500);
});

// 状態を変えるリクエストは独自ヘッダー必須（CSRF対策。SameSite=Lax Cookie と併用）
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("X-Requested-With") !== "nippo") fail(403, "不正なリクエストです");
  await next();
});

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const sqlNow = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400_000).toISOString().replace("T", " ").slice(0, 19);

async function audit(c: C, action: string, target = "") {
  await c.env.DB.prepare("INSERT INTO audit_logs (actor_id, action, target) VALUES (?, ?, ?)")
    .bind(c.get("me")?.id ?? null, action, target)
    .run();
}

// ---------------------------------------------------------------------------
// セットアップ・認証
// ---------------------------------------------------------------------------

app.get("/setup", async (c) => {
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return c.json({ needed: !n?.n });
});

/** 最初のシステム管理者を作る（ユーザーが0人、かつ SETUP_TOKEN が一致するときだけ） */
app.post("/setup", async (c) => {
  const body = await c.req.json();
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if (n?.n) fail(400, "セットアップは完了しています");
  if (!c.env.SETUP_TOKEN || body.token !== c.env.SETUP_TOKEN) fail(403, "セットアップ用トークンが違います");
  const email = str(body.email, 200).toLowerCase();
  const name = str(body.name, 100);
  if (!email.includes("@") || !name) fail(400, "メールアドレスと氏名を入力してください");
  if (str(body.password, 200).length < 10) fail(400, "パスワードは10文字以上にしてください");
  await c.env.DB.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'sysadmin', ?)")
    .bind(email, name, await hashPassword(body.password))
    .run();
  return c.json({ ok: true });
});

async function startSession(c: C, userId: number) {
  const token = randomToken();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, sqlNow(SESSION_DAYS))
    .run();
  setCookie(c, "sid", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

app.post("/login", async (c) => {
  const body = await c.req.json();
  const email = str(body.email, 200).toLowerCase();
  const fails = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?")
    .bind(email, sqlNow(-1 / 96))
    .first<{ n: number }>();
  if ((fails?.n ?? 0) >= 10) fail(429, "ログインの失敗が続いたため、15分ほど待ってからお試しください");
  const user = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ? AND active = 1")
    .bind(email)
    .first<{ id: number; password_hash: string | null }>();
  if (!user || !(await verifyPassword(str(body.password, 200), user.password_hash))) {
    await c.env.DB.prepare("INSERT INTO login_failures (email) VALUES (?)").bind(email).run();
    fail(401, "メールアドレスまたはパスワードが違います");
  }
  await startSession(c, user!.id);
  return c.json({ ok: true });
});

/** 招待リンク・再設定リンクからパスワードを設定する */
app.post("/invite/accept", async (c) => {
  const body = await c.req.json();
  const password = str(body.password, 200);
  if (password.length < 10) fail(400, "パスワードは10文字以上にしてください");
  const inv = await c.env.DB.prepare("SELECT user_id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256(str(body.token, 200)), sqlNow())
    .first<{ user_id: number }>();
  if (!inv) fail(400, "このリンクは無効か、期限が切れています。管理者に再発行を依頼してください");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), inv!.user_id),
    c.env.DB.prepare("UPDATE invites SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").bind(inv!.user_id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(inv!.user_id),
  ]);
  await startSession(c, inv!.user_id);
  return c.json({ ok: true });
});

app.get("/invite/:token", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT u.name, u.email FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?",
  )
    .bind(await sha256(c.req.param("token")), sqlNow())
    .first();
  if (!row) fail(404, "このリンクは無効か、期限が切れています");
  return c.json(row);
});

// ここから先はログイン必須
app.use("*", async (c, next) => {
  const token = getCookie(c, "sid");
  if (token) {
    const me = await c.env.DB.prepare(
      `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.supervisor_id, u.consented_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    )
      .bind(await sha256(token), sqlNow())
      .first<Me>();
    if (me) {
      c.set("me", me);
      return next();
    }
  }
  fail(401, "ログインしてください");
});

app.post("/logout", async (c) => {
  const token = getCookie(c, "sid");
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, "sid", { path: "/" });
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const me = c.get("me");
  const tenant = me.tenant_id
    ? await c.env.DB.prepare("SELECT id, name, settings FROM tenants WHERE id = ?").bind(me.tenant_id).first<{ id: number; name: string; settings: string }>()
    : null;
  const subordinates = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE supervisor_id = ? AND active = 1")
    .bind(me.id)
    .first<{ n: number }>();
  return c.json({
    ...me,
    tenant: tenant && { id: tenant.id, name: tenant.name, settings: safeJson(tenant.settings) },
    has_subordinates: (subordinates?.n ?? 0) > 0,
  });
});

app.post("/me/consent", async (c) => {
  await c.env.DB.prepare("UPDATE users SET consented_at = datetime('now') WHERE id = ?").bind(c.get("me").id).run();
  return c.json({ ok: true });
});

app.post("/me/password", async (c) => {
  const body = await c.req.json();
  const me = c.get("me");
  const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(me.id).first<{ password_hash: string }>();
  if (!(await verifyPassword(str(body.current, 200), row?.password_hash ?? null))) fail(400, "現在のパスワードが違います");
  if (str(body.next, 200).length < 10) fail(400, "パスワードは10文字以上にしてください");
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(body.next), me.id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 権限
// ---------------------------------------------------------------------------

async function laborTenantIds(c: C): Promise<number[] | "all"> {
  const me = c.get("me");
  if (me.role === "sysadmin") return "all";
  if (me.role !== "labor") return [];
  const rows = await c.env.DB.prepare("SELECT tenant_id FROM labor_assignments WHERE user_id = ?").bind(me.id).all<{ tenant_id: number }>();
  return rows.results.map((r) => r.tenant_id);
}

async function isLaborFor(c: C, tenantId: number): Promise<boolean> {
  const ids = await laborTenantIds(c);
  return ids === "all" || ids.includes(tenantId);
}

async function requireLabor(c: C, tenantId: number) {
  if (!(await isLaborFor(c, tenantId))) fail(403, "この企業の労務管理権限がありません");
}

/** ユーザー管理ができるか（社長は自社のみ、労務管理者は担当企業、システム管理者は全て） */
async function canManageTenant(c: C, tenantId: number): Promise<boolean> {
  const me = c.get("me");
  if (me.role === "owner" && me.tenant_id === tenantId) return true;
  return isLaborFor(c, tenantId);
}

interface Target {
  id: number;
  tenant_id: number;
  supervisor_id: number | null;
}

/** 日報を読めるか: 本人 / 直属の上長 / 同じ企業の社長 / 担当の労務管理者 */
async function canViewReportsOf(c: C, target: Target): Promise<boolean> {
  const me = c.get("me");
  if (me.id === target.id) return true;
  if (target.supervisor_id === me.id) return true;
  if (me.role === "owner" && me.tenant_id === target.tenant_id) return true;
  return isLaborFor(c, target.tenant_id);
}

const tenantParam = (c: C) => {
  const v = Number(c.req.query("tenant_id") ?? c.get("me").tenant_id);
  if (!v) fail(400, "企業を指定してください");
  return v;
};

// ---------------------------------------------------------------------------
// 日報
// ---------------------------------------------------------------------------

async function keywordRules(db: D1Database, tenantId: number): Promise<KeywordRule[]> {
  const rows = await db.prepare("SELECT word, severity FROM keyword_rules WHERE tenant_id IS NULL OR tenant_id = ?").bind(tenantId).all<KeywordRule>();
  return rows.results;
}

app.put("/reports", async (c) => {
  const me = c.get("me");
  if (!me.tenant_id) fail(400, "企業に所属していないため日報は書けません");
  const b = await c.req.json();
  const date = str(b.report_date, 10);
  if (!DATE_RE.test(date)) fail(400, "日付が正しくありません");
  if (date > addDays(jstToday(), 1)) fail(400, "未来の日報は書けません");
  const condition = Number(b.condition);
  if (!(condition >= 1 && condition <= 5)) fail(400, "今日の調子を選んでください");
  const done = str(b.done);
  if (!done) fail(400, "「今日やったこと」を入力してください");
  const endTime = str(b.end_time, 5) || null;
  if (endTime && !TIME_RE.test(endTime)) fail(400, "退勤時刻は HH:MM で入力してください");
  const fields = [condition, done, str(b.redo), str(b.growth), str(b.plan), endTime, str(b.kk, 1000)];

  const row = await c.env.DB.prepare(
    `INSERT INTO reports (user_id, tenant_id, report_date, condition, done, redo, growth, plan, end_time, kk)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, report_date) DO UPDATE SET
       condition = excluded.condition, done = excluded.done, redo = excluded.redo, growth = excluded.growth,
       plan = excluded.plan, end_time = excluded.end_time, kk = excluded.kk, updated_at = datetime('now')
     RETURNING id`,
  )
    .bind(me.id, me.tenant_id, date, ...fields)
    .first<{ id: number }>();
  const reportId = row!.id;

  // 即時の兆候検知: キーワードと相談
  const rules = await keywordRules(c.env.DB, me.tenant_id!);
  const consult = str(b.consult);
  const drafts: AlertDraft[] = [];
  const hit = matchKeywords([done, b.redo, b.growth, b.plan].map((s) => str(s)).join("\n"), rules);
  if (hit) {
    drafts.push({
      tenantId: me.tenant_id!, userId: me.id, kind: "keyword", severity: hit.severity,
      detail: `${date} の日報に「${hit.words.join("」「")}」が含まれています`,
      dedupeKey: `keyword:${reportId}:${hit.words.join(",")}`,
    });
  }
  if (consult) {
    const res = await c.env.DB.prepare("INSERT INTO consultations (user_id, tenant_id, report_id, body) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(me.id, me.tenant_id, reportId, consult)
      .first<{ id: number }>();
    const cHit = matchKeywords(consult, rules);
    drafts.push({
      tenantId: me.tenant_id!, userId: me.id, kind: "consultation",
      severity: cHit?.severity === "high" ? "high" : "mid",
      detail: `労務担当への相談が届きました${cHit ? `（「${cHit.words.join("」「")}」を含む）` : ""}`,
      dedupeKey: `consultation:${res!.id}`,
    });
  }
  await insertAlerts(c.env.DB, drafts);
  return c.json({ id: reportId });
});

app.get("/reports/mine", async (c) => {
  const me = c.get("me");
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.report_date, r.condition, r.done,
            (SELECT COUNT(*) FROM comments WHERE report_id = r.id AND kind = 'comment') AS comment_count,
            (SELECT COUNT(*) FROM comments WHERE report_id = r.id AND kind = 'like') AS like_count
       FROM reports r WHERE r.user_id = ? ORDER BY r.report_date DESC LIMIT 60`,
  )
    .bind(me.id)
    .all();
  return c.json(rows.results);
});

app.get("/reports/date/:date", async (c) => {
  const date = c.req.param("date");
  if (!DATE_RE.test(date)) fail(400, "日付が正しくありません");
  const row = await c.env.DB.prepare("SELECT * FROM reports WHERE user_id = ? AND report_date = ?").bind(c.get("me").id, date).first();
  return c.json(row ?? null);
});

async function loadReport(c: C, id: number) {
  const r = await c.env.DB.prepare(
    `SELECT r.*, u.name AS author_name, u.supervisor_id AS author_supervisor_id
       FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
  )
    .bind(id)
    .first<Record<string, any>>();
  if (!r) fail(404, "日報が見つかりません");
  if (!(await canViewReportsOf(c, { id: r!.user_id, tenant_id: r!.tenant_id, supervisor_id: r!.author_supervisor_id }))) {
    fail(403, "この日報を見る権限がありません");
  }
  return r!;
}

app.get("/reports/:id", async (c) => {
  const me = c.get("me");
  const r = await loadReport(c, Number(c.req.param("id")));
  if (r.user_id !== me.id) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO report_reads (report_id, user_id) VALUES (?, ?)").bind(r.id, me.id).run();
    if (me.role === "labor" || me.role === "sysadmin") await audit(c, "view_report", `report:${r.id}`);
  }
  const comments = await c.env.DB.prepare(
    "SELECT cm.id, cm.kind, cm.body, cm.created_at, cm.user_id, u.name FROM comments cm JOIN users u ON u.id = cm.user_id WHERE report_id = ? ORDER BY cm.id",
  )
    .bind(r.id)
    .all();
  const readers = await c.env.DB.prepare(
    "SELECT u.name, rr.read_at FROM report_reads rr JOIN users u ON u.id = rr.user_id WHERE rr.report_id = ? ORDER BY rr.read_at",
  )
    .bind(r.id)
    .all();
  delete r.author_supervisor_id;
  return c.json({ report: r, comments: comments.results, readers: readers.results });
});

app.post("/reports/:id/comments", async (c) => {
  const me = c.get("me");
  const r = await loadReport(c, Number(c.req.param("id")));
  const b = await c.req.json();
  const kind = b.kind === "like" ? "like" : "comment";
  const body = str(b.body, 2000);
  if (kind === "comment" && !body) fail(400, "コメントを入力してください");
  if (kind === "like") {
    const exists = await c.env.DB.prepare("SELECT id FROM comments WHERE report_id = ? AND user_id = ? AND kind = 'like'").bind(r.id, me.id).first();
    if (exists) return c.json({ ok: true });
  }
  await c.env.DB.prepare("INSERT INTO comments (report_id, user_id, kind, body) VALUES (?, ?, ?, ?)").bind(r.id, me.id, kind, body).run();
  return c.json({ ok: true });
});

/** 部下（社長・労務は企業全体）の日報一覧と未提出者 */
app.get("/team/reports", async (c) => {
  const me = c.get("me");
  const date = c.req.query("date") || jstToday();
  if (!DATE_RE.test(date)) fail(400, "日付が正しくありません");
  let members: { id: number; name: string }[];
  const tenantId = Number(c.req.query("tenant_id") || me.tenant_id);
  if ((me.role === "owner" && me.tenant_id === tenantId) || (tenantId && (await isLaborFor(c, tenantId)))) {
    members = (
      await c.env.DB.prepare("SELECT id, name FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('employee','supervisor','owner') AND id != ? ORDER BY name")
        .bind(tenantId, me.id)
        .all<{ id: number; name: string }>()
    ).results;
  } else {
    members = (
      await c.env.DB.prepare("SELECT id, name FROM users WHERE supervisor_id = ? AND active = 1 ORDER BY name").bind(me.id).all<{ id: number; name: string }>()
    ).results;
  }
  if (!members.length) return c.json({ date, reports: [], missing: [] });
  const ph = members.map(() => "?").join(",");
  const reports = await c.env.DB.prepare(
    `SELECT r.id, r.user_id, u.name, r.condition, r.done, r.report_date,
            EXISTS (SELECT 1 FROM report_reads WHERE report_id = r.id AND user_id = ?) AS is_read,
            (SELECT COUNT(*) FROM comments WHERE report_id = r.id AND kind = 'comment') AS comment_count
       FROM reports r JOIN users u ON u.id = r.user_id
      WHERE r.report_date = ? AND r.user_id IN (${ph}) ORDER BY u.name`,
  )
    .bind(me.id, date, ...members.map((m) => m.id))
    .all<{ user_id: number }>();
  const submitted = new Set(reports.results.map((r) => r.user_id));
  return c.json({ date, reports: reports.results, missing: members.filter((m) => !submitted.has(m.id)) });
});

// ---------------------------------------------------------------------------
// 労務管理
// ---------------------------------------------------------------------------

app.get("/labor/tenants", async (c) => c.json(await listLaborTenants(c)));

async function listLaborTenants(c: C) {
  const ids = await laborTenantIds(c);
  const rows =
    ids === "all"
      ? await c.env.DB.prepare("SELECT id, name, settings FROM tenants ORDER BY name").all()
      : ids.length
        ? await c.env.DB.prepare(`SELECT id, name, settings FROM tenants WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY name`).bind(...ids).all()
        : { results: [] };
  return rows.results.map((t: any) => ({ ...t, settings: safeJson(t.settings) }));
}

/** 社員一覧（ステータス・直近の調子・未対応アラート数） */
app.get("/labor/overview", async (c) => {
  const tenantId = tenantParam(c);
  await requireLabor(c, tenantId);
  const today = jstToday();
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.role, s.name AS supervisor_name,
            COALESCE(es.status, 'good') AS status, es.updated_at AS status_updated_at,
            (SELECT ROUND(AVG(condition), 1) FROM reports WHERE user_id = u.id AND report_date >= ?2) AS avg7,
            (SELECT ROUND(AVG(condition), 1) FROM reports WHERE user_id = u.id AND report_date >= ?3 AND report_date < ?2) AS avg_prev,
            (SELECT COUNT(*) FROM reports WHERE user_id = u.id AND report_date >= ?2) AS submitted7,
            (SELECT MAX(report_date) FROM reports WHERE user_id = u.id) AS last_report,
            (SELECT COUNT(*) FROM alerts WHERE user_id = u.id AND status != 'closed') AS open_alerts
       FROM users u
       LEFT JOIN users s ON s.id = u.supervisor_id
       LEFT JOIN employee_status es ON es.user_id = u.id
      WHERE u.tenant_id = ?1 AND u.active = 1 AND u.role IN ('employee','supervisor')
      ORDER BY open_alerts DESC, u.name`,
  )
    .bind(tenantId, addDays(today, -6), addDays(today, -34))
    .all();
  return c.json(rows.results);
});

app.get("/labor/alerts", async (c) => {
  const tenantId = tenantParam(c);
  await requireLabor(c, tenantId);
  const status = c.req.query("status") || "open";
  const where = status === "open" ? "a.status != 'closed'" : status === "all" ? "1=1" : "a.status = ?2";
  const stmt = c.env.DB.prepare(
    `SELECT a.*, u.name AS user_name FROM alerts a JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ?1 AND ${where}
      ORDER BY CASE a.severity WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 200`,
  );
  const rows = await (status === "open" || status === "all" ? stmt.bind(tenantId) : stmt.bind(tenantId, status)).all();
  return c.json(rows.results);
});

app.patch("/labor/alerts/:id", async (c) => {
  const me = c.get("me");
  const a = await c.env.DB.prepare("SELECT id, tenant_id, status FROM alerts WHERE id = ?").bind(Number(c.req.param("id"))).first<{ id: number; tenant_id: number; status: string }>();
  if (!a) fail(404, "アラートが見つかりません");
  await requireLabor(c, a!.tenant_id);
  const b = await c.req.json();
  const stmts = [];
  if (b.status && b.status !== a!.status) {
    if (!["new", "checking", "meeting", "in_progress", "closed"].includes(b.status)) fail(400, "ステータスが正しくありません");
    stmts.push(c.env.DB.prepare("UPDATE alerts SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(b.status, a!.id));
  }
  const note = str(b.note, 2000);
  const label = b.status && b.status !== a!.status ? `［${a!.status} → ${b.status}］` : "";
  if (note || label) stmts.push(c.env.DB.prepare("INSERT INTO alert_notes (alert_id, user_id, body) VALUES (?, ?, ?)").bind(a!.id, me.id, `${label}${note}`));
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

app.get("/labor/alerts/:id/notes", async (c) => {
  const a = await c.env.DB.prepare("SELECT tenant_id FROM alerts WHERE id = ?").bind(Number(c.req.param("id"))).first<{ tenant_id: number }>();
  if (!a) fail(404, "アラートが見つかりません");
  await requireLabor(c, a!.tenant_id);
  const rows = await c.env.DB.prepare(
    "SELECT n.body, n.created_at, u.name FROM alert_notes n JOIN users u ON u.id = n.user_id WHERE alert_id = ? ORDER BY n.id",
  )
    .bind(Number(c.req.param("id")))
    .all();
  return c.json(rows.results);
});

async function loadEmployee(c: C, id: number) {
  const u = await c.env.DB.prepare(
    "SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.supervisor_id, s.name AS supervisor_name FROM users u LEFT JOIN users s ON s.id = u.supervisor_id WHERE u.id = ?",
  )
    .bind(id)
    .first<Record<string, any>>();
  if (!u || !u.tenant_id) fail(404, "社員が見つかりません");
  await requireLabor(c, u!.tenant_id);
  return u!;
}

app.get("/labor/employees/:id", async (c) => {
  const u = await loadEmployee(c, Number(c.req.param("id")));
  await audit(c, "view_employee", `user:${u.id}`);
  const db = c.env.DB;
  const [status, history, reports, alerts, consultations] = await Promise.all([
    db.prepare("SELECT es.*, u.name AS updated_by_name FROM employee_status es LEFT JOIN users u ON u.id = es.updated_by WHERE es.user_id = ?").bind(u.id).first(),
    db.prepare("SELECT h.*, u.name AS changed_by_name FROM status_history h JOIN users u ON u.id = h.changed_by WHERE h.user_id = ? ORDER BY h.id DESC LIMIT 50").bind(u.id).all(),
    db.prepare("SELECT id, report_date, condition, done, end_time FROM reports WHERE user_id = ? AND report_date >= ? ORDER BY report_date").bind(u.id, addDays(jstToday(), -89)).all(),
    db.prepare("SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(u.id).all(),
    db.prepare("SELECT * FROM consultations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(u.id).all(),
  ]);
  return c.json({
    user: u,
    status: status ?? { status: "good", note: "" },
    history: history.results,
    reports: reports.results,
    alerts: alerts.results,
    consultations: consultations.results,
  });
});

app.put("/labor/employees/:id/status", async (c) => {
  const me = c.get("me");
  const u = await loadEmployee(c, Number(c.req.param("id")));
  const b = await c.req.json();
  if (!["good", "watch", "follow", "handling", "leave"].includes(b.status)) fail(400, "ステータスが正しくありません");
  const note = str(b.note, 2000);
  const cur = await c.env.DB.prepare("SELECT status FROM employee_status WHERE user_id = ?").bind(u.id).first<{ status: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO employee_status (user_id, status, note, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    ).bind(u.id, b.status, note, me.id),
    c.env.DB.prepare("INSERT INTO status_history (user_id, old_status, new_status, note, changed_by) VALUES (?, ?, ?, ?, ?)").bind(
      u.id, cur?.status ?? "good", b.status, note, me.id,
    ),
  ]);
  return c.json({ ok: true });
});

app.get("/labor/consultations", async (c) => {
  const tenantId = tenantParam(c);
  await requireLabor(c, tenantId);
  await audit(c, "view_consultations", `tenant:${tenantId}`);
  const rows = await c.env.DB.prepare(
    "SELECT co.*, u.name AS user_name FROM consultations co JOIN users u ON u.id = co.user_id WHERE co.tenant_id = ? ORDER BY co.created_at DESC LIMIT 200",
  )
    .bind(tenantId)
    .all();
  return c.json(rows.results);
});

app.post("/labor/run-detection", async (c) => {
  const ids = await laborTenantIds(c);
  if (ids !== "all" && !ids.length) fail(403, "権限がありません");
  const created = await runDetection(c.env.DB);
  return c.json({ created });
});

app.get("/labor/keywords", async (c) => {
  const tenantId = tenantParam(c);
  await requireLabor(c, tenantId);
  const rows = await c.env.DB.prepare("SELECT id, tenant_id, word, severity FROM keyword_rules WHERE tenant_id IS NULL OR tenant_id = ? ORDER BY severity DESC, word")
    .bind(tenantId)
    .all();
  return c.json(rows.results);
});

app.post("/labor/keywords", async (c) => {
  const b = await c.req.json();
  const me = c.get("me");
  // 全社共通の辞書はシステム管理者のみ編集可
  const tenantId = b.common ? null : Number(b.tenant_id);
  if (tenantId === null ? me.role !== "sysadmin" : !(await isLaborFor(c, tenantId))) fail(403, "権限がありません");
  const word = str(b.word, 50);
  if (!word || !["low", "mid", "high"].includes(b.severity)) fail(400, "言葉と重要度を指定してください");
  await c.env.DB.prepare("INSERT INTO keyword_rules (tenant_id, word, severity) VALUES (?, ?, ?)").bind(tenantId, word, b.severity).run();
  return c.json({ ok: true });
});

app.delete("/labor/keywords/:id", async (c) => {
  const me = c.get("me");
  const k = await c.env.DB.prepare("SELECT tenant_id FROM keyword_rules WHERE id = ?").bind(Number(c.req.param("id"))).first<{ tenant_id: number | null }>();
  if (!k) fail(404, "見つかりません");
  if (k!.tenant_id === null ? me.role !== "sysadmin" : !(await isLaborFor(c, k!.tenant_id))) fail(403, "権限がありません");
  await c.env.DB.prepare("DELETE FROM keyword_rules WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 社長向けダッシュボード（個人の相談内容は含めない集計のみ）
// ---------------------------------------------------------------------------

app.get("/dashboard", async (c) => {
  const me = c.get("me");
  const tenantId = tenantParam(c);
  if (!((me.role === "owner" && me.tenant_id === tenantId) || (await isLaborFor(c, tenantId)))) fail(403, "権限がありません");
  const today = jstToday();
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(addDays(today, -i));
  const members = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('employee','supervisor')")
    .bind(tenantId)
    .first<{ n: number }>();
  const daily = await c.env.DB.prepare(
    "SELECT report_date, COUNT(*) AS submitted, ROUND(AVG(condition), 2) AS avg_condition FROM reports WHERE tenant_id = ? AND report_date >= ? GROUP BY report_date",
  )
    .bind(tenantId, days[0])
    .all<{ report_date: string; submitted: number; avg_condition: number }>();
  const statuses = await c.env.DB.prepare(
    `SELECT COALESCE(es.status, 'good') AS status, COUNT(*) AS n FROM users u LEFT JOIN employee_status es ON es.user_id = u.id
      WHERE u.tenant_id = ? AND u.active = 1 AND u.role IN ('employee','supervisor') GROUP BY 1`,
  )
    .bind(tenantId)
    .all();
  const byDate = new Map(daily.results.map((d) => [d.report_date, d]));
  return c.json({
    members: members?.n ?? 0,
    days: days.map((d) => ({ date: d, submitted: byDate.get(d)?.submitted ?? 0, avg_condition: byDate.get(d)?.avg_condition ?? null })),
    statuses: statuses.results,
  });
});

// ---------------------------------------------------------------------------
// 管理（企業・ユーザー）
// ---------------------------------------------------------------------------

app.get("/admin/tenants", async (c) => {
  const me = c.get("me");
  if (me.role === "owner") {
    const t = await c.env.DB.prepare("SELECT id, name, settings FROM tenants WHERE id = ?").bind(me.tenant_id).all();
    return c.json(t.results.map((x: any) => ({ ...x, settings: safeJson(x.settings) })));
  }
  return c.json(await listLaborTenants(c));
});

app.post("/admin/tenants", async (c) => {
  if (c.get("me").role !== "sysadmin") fail(403, "企業の追加はシステム管理者のみ可能です");
  const name = str((await c.req.json()).name, 100);
  if (!name) fail(400, "企業名を入力してください");
  const row = await c.env.DB.prepare("INSERT INTO tenants (name, settings) VALUES (?, ?) RETURNING id")
    .bind(name, JSON.stringify({ showEndTime: true, showKK: false, standardEnd: "17:30" }))
    .first<{ id: number }>();
  return c.json(row);
});

/** デモ会社（デモ株式会社）の有無 */
app.get("/admin/demo", async (c) => {
  if (c.get("me").role !== "sysadmin") fail(403, "権限がありません");
  const t = await c.env.DB.prepare("SELECT id FROM tenants WHERE id = ?").bind(DEMO_TENANT_ID).first();
  return c.json({ exists: !!t });
});

/** デモデータを入れる（約2ヶ月分。デモユーザー全員に同じパスワードを設定） */
app.post("/admin/demo", async (c) => {
  if (c.get("me").role !== "sysadmin") fail(403, "権限がありません");
  const password = str((await c.req.json()).password, 200);
  if (password.length < 10) fail(400, "デモユーザーのパスワードは10文字以上にしてください");
  if (await c.env.DB.prepare("SELECT id FROM tenants WHERE id = ?").bind(DEMO_TENANT_ID).first()) fail(400, "デモデータは入っています。入れ直すときは先に消してください");
  const base = await c.env.DB.prepare(DEMO_ID_BASE_SQL).first<DemoIdBase>();
  const sql = buildDemoSql(jstToday(), await hashPassword(password), base!);
  await c.env.DB.batch(sql.map((s) => c.env.DB.prepare(s)));
  await audit(c, "demo_insert");
  return c.json({ ok: true });
});

/** デモデータを消す */
app.delete("/admin/demo", async (c) => {
  if (c.get("me").role !== "sysadmin") fail(403, "権限がありません");
  await c.env.DB.batch(DEMO_CLEAR_SQL.map((s) => c.env.DB.prepare(s)));
  await audit(c, "demo_clear");
  return c.json({ ok: true });
});

app.patch("/admin/tenants/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await canManageTenant(c, id))) fail(403, "権限がありません");
  const b = await c.req.json();
  const settings = {
    showEndTime: !!b.settings?.showEndTime,
    showKK: !!b.settings?.showKK,
    standardEnd: TIME_RE.test(b.settings?.standardEnd) ? b.settings.standardEnd : "17:30",
  };
  await c.env.DB.prepare("UPDATE tenants SET name = COALESCE(NULLIF(?, ''), name), settings = ? WHERE id = ?")
    .bind(str(b.name, 100), JSON.stringify(settings), id)
    .run();
  return c.json({ ok: true });
});

app.get("/admin/users", async (c) => {
  const me = c.get("me");
  const q = c.req.query("tenant_id");
  if (q === "staff") {
    // リライエ側スタッフ（企業に属さない労務管理者・システム管理者）
    if (me.role !== "sysadmin") fail(403, "権限がありません");
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.password_hash IS NOT NULL AS activated,
              (SELECT GROUP_CONCAT(tenant_id) FROM labor_assignments WHERE user_id = u.id) AS tenant_ids
         FROM users u WHERE u.tenant_id IS NULL ORDER BY u.name`,
    ).all();
    return c.json(rows.results);
  }
  const tenantId = tenantParam(c);
  if (!(await canManageTenant(c, tenantId))) fail(403, "権限がありません");
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.supervisor_id, u.active, u.password_hash IS NOT NULL AS activated
       FROM users u WHERE u.tenant_id = ? ORDER BY u.active DESC, u.name`,
  )
    .bind(tenantId)
    .all();
  return c.json(rows.results);
});

async function issueInvite(c: C, userId: number): Promise<string> {
  const token = randomToken();
  await c.env.DB.prepare("INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, sqlNow(INVITE_DAYS))
    .run();
  return `${new URL(c.req.url).origin}/#/invite/${token}`;
}

/** 作成できるロール: 社長→社員・上長・社長 / 労務→＋企業側の労務 / システム管理者→すべて */
function assertRoleAllowed(me: Me, role: string, tenantId: number | null) {
  const base = ["employee", "supervisor", "owner"];
  const allowed = me.role === "sysadmin" ? [...base, "labor", "sysadmin"] : me.role === "labor" ? [...base, "labor"] : base;
  if (!allowed.includes(role)) fail(403, "このロールのユーザーは作成できません");
  if (role === "sysadmin" && tenantId !== null) fail(400, "システム管理者は企業に所属させられません");
  if (base.includes(role) && tenantId === null) fail(400, "企業を指定してください");
}

async function assertSupervisor(c: C, supervisorId: number | null, tenantId: number | null) {
  if (!supervisorId) return;
  const s = await c.env.DB.prepare("SELECT tenant_id FROM users WHERE id = ?").bind(supervisorId).first<{ tenant_id: number }>();
  if (!s || s.tenant_id !== tenantId) fail(400, "上長は同じ企業のユーザーから選んでください");
}

app.post("/admin/users", async (c) => {
  const me = c.get("me");
  const b = await c.req.json();
  const tenantId = b.tenant_id ? Number(b.tenant_id) : null;
  if (tenantId === null ? me.role !== "sysadmin" : !(await canManageTenant(c, tenantId))) fail(403, "権限がありません");
  assertRoleAllowed(me, b.role, tenantId);
  const email = str(b.email, 200).toLowerCase();
  const name = str(b.name, 100);
  if (!email.includes("@") || !name) fail(400, "メールアドレスと氏名を入力してください");
  const supervisorId = b.supervisor_id ? Number(b.supervisor_id) : null;
  await assertSupervisor(c, supervisorId, tenantId);
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) fail(400, "このメールアドレスは登録済みです");
  const row = await c.env.DB.prepare("INSERT INTO users (tenant_id, email, name, role, supervisor_id) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(tenantId, email, name, b.role, supervisorId)
    .first<{ id: number }>();
  if (b.role === "labor" && tenantId) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO labor_assignments (user_id, tenant_id) VALUES (?, ?)").bind(row!.id, tenantId).run();
  }
  await audit(c, "create_user", `user:${row!.id}`);
  return c.json({ id: row!.id, invite_url: await issueInvite(c, row!.id) });
});

async function loadManagedUser(c: C, id: number) {
  const u = await c.env.DB.prepare("SELECT id, tenant_id, role FROM users WHERE id = ?").bind(id).first<{ id: number; tenant_id: number | null; role: Role }>();
  if (!u) fail(404, "ユーザーが見つかりません");
  const ok = u!.tenant_id === null ? c.get("me").role === "sysadmin" : await canManageTenant(c, u!.tenant_id);
  if (!ok) fail(403, "権限がありません");
  return u!;
}

app.patch("/admin/users/:id", async (c) => {
  const me = c.get("me");
  const u = await loadManagedUser(c, Number(c.req.param("id")));
  const b = await c.req.json();
  const role = b.role ?? u.role;
  assertRoleAllowed(me, role, u.tenant_id);
  if (u.role !== role) assertRoleAllowed(me, u.role, u.tenant_id); // 自分より上のロールを書き換えさせない
  const supervisorId = b.supervisor_id ? Number(b.supervisor_id) : null;
  if (supervisorId === u.id) fail(400, "自分自身を上長にはできません");
  await assertSupervisor(c, supervisorId, u.tenant_id);
  if (u.id === me.id && b.active === false) fail(400, "自分自身は無効にできません");
  const stmts = [
    c.env.DB.prepare("UPDATE users SET name = COALESCE(NULLIF(?, ''), name), role = ?, supervisor_id = ?, active = ? WHERE id = ?").bind(
      str(b.name, 100), role, supervisorId, b.active === false ? 0 : 1, u.id,
    ),
  ];
  if (b.active === false) stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id));
  await c.env.DB.batch(stmts);
  await audit(c, "update_user", `user:${u.id}`);
  return c.json({ ok: true });
});

app.post("/admin/users/:id/invite", async (c) => {
  const u = await loadManagedUser(c, Number(c.req.param("id")));
  await audit(c, "reissue_invite", `user:${u.id}`);
  return c.json({ invite_url: await issueInvite(c, u.id) });
});

app.put("/admin/labor-assignments", async (c) => {
  if (c.get("me").role !== "sysadmin") fail(403, "権限がありません");
  const b = await c.req.json();
  const userId = Number(b.user_id);
  const tenantIds: number[] = Array.isArray(b.tenant_ids) ? b.tenant_ids.map(Number).filter(Boolean) : [];
  const u = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: string }>();
  if (u?.role !== "labor") fail(400, "労務管理者のユーザーを指定してください");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM labor_assignments WHERE user_id = ?").bind(userId),
    ...tenantIds.map((t) => c.env.DB.prepare("INSERT INTO labor_assignments (user_id, tenant_id) VALUES (?, ?)").bind(userId, t)),
  ]);
  return c.json({ ok: true });
});

app.all("*", (c) => c.json({ error: "見つかりません" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const created = await runDetection(env.DB);
        await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(sqlNow()).run();
        await env.DB.prepare("DELETE FROM login_failures WHERE at < ?").bind(sqlNow(-1)).run();
        console.log(`detection: ${created} alerts created`);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
