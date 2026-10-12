// 日報アプリ フロントエンド（フレームワークなし・ハッシュルーティング）

const $app = document.getElementById("app");
const MOODS = [
  { v: 1, face: "😣", label: "つらい" },
  { v: 2, face: "😕", label: "いまいち" },
  { v: 3, face: "😐", label: "ふつう" },
  { v: 4, face: "🙂", label: "よい" },
  { v: 5, face: "😄", label: "とてもよい" },
];
const ROLE_LABEL = { employee: "社員", supervisor: "上長", owner: "社長", labor: "労務管理者", sysadmin: "システム管理者" };
const STATUS_LABEL = { good: "良好", watch: "様子見", follow: "要フォロー", handling: "対応中", leave: "休職中" };
const ALERT_STATUS = { new: "新規", checking: "確認中", meeting: "面談調整中", in_progress: "対応中", closed: "解決" };
const SEV_LABEL = { low: "低", mid: "中", high: "高" };
const KIND_LABEL = {
  keyword: "気になる言葉", consultation: "労務担当への相談", condition_drop: "調子の低下", low_streak: "低調の連続",
  unsubmitted: "未提出", overtime: "長時間労働", text_shrink: "記述量の急減", supervisor_silence: "上長の無反応",
};

let me = null;
let laborTenants = [];

// ---- ユーティリティ ----

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mood = (v) => MOODS.find((m) => m.v === Number(v)) || { face: "-", label: "" };
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const fmtDate = (d) => {
  if (!d) return "-";
  const dt = new Date(d.slice(0, 10) + "T00:00:00Z");
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}（${"日月火水木金土"[dt.getUTCDay()]}）`;
};
const fmtTime = (s) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Requested-With": "nippo" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/invite")) {
    me = null;
    // セットアップ・招待などログイン前の画面にいるときはログイン画面へ飛ばさない
    if (!PUBLIC.some((r) => r.test(location.hash))) location.hash = "#/login";
    throw new Error(data.error || "ログインしてください");
  }
  if (!res.ok) throw new Error(data.error || "エラーが発生しました");
  return data;
}

function render(html) {
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

/** フォーム送信を共通化: エラーはフォーム内に表示 */
function onSubmit(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const err = form.querySelector(".error");
    if (err) err.textContent = "";
    if (btn) btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (ex) {
      if (err) err.textContent = ex.message;
      else toast(ex.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

const isLabor = () => me && (me.role === "labor" || me.role === "sysadmin");
const isManager = () => me && (me.role === "owner" || isLabor());
const currentTenantId = () => {
  if (!isLabor()) return me?.tenant_id;
  let id = 0;
  try { id = Number(localStorage.getItem("tenant_id")); } catch {}
  return laborTenants.some((t) => t.id === id) ? id : laborTenants[0]?.id;
};
const currentTenant = () => (isLabor() ? laborTenants.find((t) => t.id === currentTenantId()) : me?.tenant);

// ---- 画面の枠 ----

function setupChrome() {
  const top = document.getElementById("topbar");
  const tabs = document.getElementById("tabs");
  if (!me) {
    top.hidden = tabs.hidden = true;
    return;
  }
  top.hidden = tabs.hidden = false;
  document.getElementById("me-name").textContent = `${me.name}（${ROLE_LABEL[me.role]}）`;
  const sel = document.getElementById("tenant-select");
  if (isLabor() && laborTenants.length) {
    sel.hidden = false;
    sel.innerHTML = laborTenants.map((t) => `<option value="${t.id}" ${t.id === currentTenantId() ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    sel.onchange = () => {
      try { localStorage.setItem("tenant_id", sel.value); } catch {}
      route();
    };
  } else sel.hidden = true;

  const items = [];
  if (me.tenant_id) items.push(["#/write", "日報を書く"], ["#/mine", "履歴"]);
  if (me.has_subordinates || isManager()) items.push(["#/team", "チーム"]);
  if (isManager()) items.push(["#/dashboard", "集計"]);
  if (isLabor()) items.push(["#/labor", "労務"]);
  if (isManager()) items.push(["#/admin", "管理"]);
  const cur = location.hash.split("/").slice(0, 2).join("/");
  tabs.innerHTML = items.map(([h, l]) => `<a href="${h}" class="${cur === h ? "active" : ""}">${l}</a>`).join("");
}

async function loadMe() {
  try {
    me = await api("/me");
    if (isLabor()) laborTenants = await api("/labor/tenants");
  } catch {
    me = null;
  }
}

// ---- ルーティング ----

const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/setup$/, viewSetup],
  [/^#\/invite\/(.+)$/, viewInvite],
  [/^#\/consent$/, viewConsent],
  [/^#\/write(?:\/(\d{4}-\d{2}-\d{2}))?$/, viewWrite],
  [/^#\/mine$/, viewMine],
  [/^#\/report\/(\d+)$/, viewReport],
  [/^#\/team$/, viewTeam],
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/labor$/, viewLabor],
  [/^#\/labor\/employee\/(\d+)$/, viewEmployee],
  [/^#\/admin$/, viewAdmin],
  [/^#\/settings$/, viewSettings],
];
const PUBLIC = [/^#\/login$/, /^#\/setup$/, /^#\/invite\//];

async function route() {
  const hash = location.hash || "#/";
  if (!me && !PUBLIC.some((r) => r.test(hash))) {
    const setup = await api("/setup").catch(() => ({}));
    location.hash = setup.needed ? "#/setup" : "#/login";
    return;
  }
  if (me && me.tenant_id && !me.consented_at && hash !== "#/consent") {
    location.hash = "#/consent";
    return;
  }
  setupChrome();
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await view(...m.slice(1));
      } catch (ex) {
        render(`<div class="card error">${esc(ex.message)}</div>`);
      }
      return;
    }
  }
  location.hash = me?.tenant_id ? "#/write" : isLabor() ? "#/labor" : "#/admin";
}

window.addEventListener("hashchange", route);

// ---- 認証まわり ----

async function viewLogin() {
  const setup = await api("/setup").catch(() => ({}));
  if (setup.needed) {
    location.hash = "#/setup";
    return;
  }
  render(`
    <div class="card">
      <h1>ログイン</h1>
      <form id="f">
        <label>メールアドレス</label><input type="email" name="email" autocomplete="username" required>
        <label>パスワード</label><input type="password" name="password" autocomplete="current-password" required>
        <p class="error"></p>
        <button type="submit" class="primary">ログイン</button>
      </form>
      <p class="muted">パスワードを忘れた場合は、会社の管理者に再設定リンクの発行を依頼してください。</p>
    </div>`);
  onSubmit(document.getElementById("f"), async (d) => {
    await api("/login", { method: "POST", body: d });
    await loadMe();
    location.hash = "#/";
  });
}

function viewSetup() {
  render(`
    <div class="card">
      <h1>初期セットアップ</h1>
      <p class="muted">最初のシステム管理者を登録します。セットアップ用トークンは Cloudflare の環境変数 SETUP_TOKEN に設定した値です。</p>
      <form id="f">
        <label>セットアップ用トークン</label><input type="password" name="token" required>
        <label>氏名</label><input type="text" name="name" required>
        <label>メールアドレス</label><input type="email" name="email" required>
        <label>パスワード<span class="opt">10文字以上</span></label><input type="password" name="password" minlength="10" autocomplete="new-password" required>
        <p class="error"></p>
        <button type="submit" class="primary">登録する</button>
      </form>
    </div>`);
  onSubmit(document.getElementById("f"), async (d) => {
    await api("/setup", { method: "POST", body: d });
    toast("登録しました。ログインしてください");
    location.hash = "#/login";
  });
}

async function viewInvite(token) {
  const info = await api("/invite/" + encodeURIComponent(token));
  render(`
    <div class="card">
      <h1>パスワードの設定</h1>
      <p>${esc(info.name)} さん（${esc(info.email)}）のパスワードを設定してください。</p>
      <form id="f">
        <label>パスワード<span class="opt">10文字以上</span></label><input type="password" name="password" minlength="10" autocomplete="new-password" required>
        <label>もう一度</label><input type="password" name="password2" minlength="10" autocomplete="new-password" required>
        <p class="error"></p>
        <button type="submit" class="primary">設定してはじめる</button>
      </form>
    </div>`);
  onSubmit(document.getElementById("f"), async (d) => {
    if (d.password !== d.password2) throw new Error("パスワードが一致しません");
    await api("/invite/accept", { method: "POST", body: { token, password: d.password } });
    await loadMe();
    location.hash = "#/";
  });
}

function viewConsent() {
  render(`
    <div class="card">
      <h1>ご利用にあたって</h1>
      <p>この日報は、上長とのコミュニケーションと、みなさんが健康に働き続けられる職場づくりのために使います。</p>
      <ul>
        <li>日報は、あなたの直属の上長・社長・担当の労務管理者（社会保険労務士）が読みます。</li>
        <li>「今日の調子」や日報の内容から、体調や職場の問題の兆しを早めに見つけ、必要なときは労務管理者からご連絡することがあります。</li>
        <li>「労務担当にだけ伝える」欄に書いた内容は、上長や社長には表示されません。</li>
        <li>データは目的の範囲内でのみ利用し、閲覧の記録を残して管理します。</li>
      </ul>
      <button class="primary" id="ok">同意してはじめる</button>
    </div>`);
  document.getElementById("ok").onclick = async () => {
    await api("/me/consent", { method: "POST", body: {} });
    await loadMe();
    location.hash = "#/write";
  };
}

function viewSettings() {
  render(`
    <div class="card">
      <h1>${esc(me.name)}</h1>
      <p class="muted">${esc(me.email)} ・ ${ROLE_LABEL[me.role]}${me.tenant ? " ・ " + esc(me.tenant.name) : ""}</p>
      <button id="logout">ログアウト</button>
    </div>
    <div class="card">
      <h2>パスワードの変更</h2>
      <form id="f">
        <label>現在のパスワード</label><input type="password" name="current" autocomplete="current-password" required>
        <label>新しいパスワード<span class="opt">10文字以上</span></label><input type="password" name="next" minlength="10" autocomplete="new-password" required>
        <p class="error"></p>
        <button type="submit" class="primary">変更する</button>
      </form>
    </div>`);
  document.getElementById("logout").onclick = async () => {
    await api("/logout", { method: "POST", body: {} });
    me = null;
    location.hash = "#/login";
  };
  onSubmit(document.getElementById("f"), async (d) => {
    await api("/me/password", { method: "POST", body: d });
    toast("パスワードを変更しました");
    document.getElementById("f").reset();
  });
}

// ---- 日報を書く ----

async function viewWrite(date) {
  date = date || today();
  const existing = await api("/reports/date/" + date);
  const s = me.tenant?.settings || {};
  const r = existing || {};
  render(`
    <form id="f" class="card">
      <div class="row">
        <h1 style="margin:0">${fmtDate(date)}の日報</h1>
        <span class="spacer"></span>
        <input type="date" name="report_date" value="${date}" max="${today()}" style="width:auto">
      </div>
      ${existing ? `<p class="muted">提出済みです。書き直すと上書きされます。<a href="#/report/${existing.id}">コメントを見る</a></p>` : ""}

      <label>今日の調子</label>
      <div class="moods" role="group" aria-label="今日の調子">
        ${MOODS.map((m) => `<button type="button" data-v="${m.v}" aria-pressed="${r.condition === m.v}">${m.face}<small>${m.label}</small></button>`).join("")}
      </div>
      <input type="hidden" name="condition" value="${r.condition || ""}">

      <label>今日やったこと</label>
      <textarea name="done" required placeholder="例）A社の見積作成、午後は現場で打ち合わせ">${esc(r.done)}</textarea>

      <label>今日もう一度やり直せるなら<span class="opt">任意</span></label>
      <textarea name="redo" placeholder="例）打ち合わせ前に資料を共有しておけばよかった">${esc(r.redo)}</textarea>

      <label>気づき・成長の記録<span class="opt">任意</span></label>
      <textarea name="growth" placeholder="目標のヒントになった言葉や出来事">${esc(r.growth)}</textarea>

      <label>明日の予定<span class="opt">任意</span></label>
      <textarea name="plan">${esc(r.plan)}</textarea>

      ${s.showEndTime ? `<label>退勤時刻<span class="opt">任意</span></label><input type="time" name="end_time" value="${esc(r.end_time || "")}" style="width:auto">` : ""}
      ${s.showKK ? `<label>経営計画書の気になる一文<span class="opt">任意</span></label><textarea name="kk">${esc(r.kk)}</textarea>` : ""}

      <div class="private">
        <label>困っていること・相談したいこと<span class="opt">任意・労務担当にだけ届きます</span></label>
        <textarea name="consult" placeholder="上長や社長には表示されません。職場の人間関係や体調のことなど、気軽に書いてください"></textarea>
      </div>

      <p class="error"></p>
      <button type="submit" class="primary" style="width:100%;margin-top:12px">${existing ? "書き直して提出" : "提出する"}</button>
    </form>`);
  const f = document.getElementById("f");
  f.querySelectorAll(".moods button").forEach((b) =>
    b.addEventListener("click", () => {
      f.querySelectorAll(".moods button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      f.condition.value = b.dataset.v;
    }),
  );
  f.report_date.addEventListener("change", () => (location.hash = "#/write/" + f.report_date.value));
  onSubmit(f, async (d) => {
    if (!d.condition) throw new Error("今日の調子を選んでください");
    const res = await api("/reports", { method: "PUT", body: d });
    toast(d.consult ? "提出しました。相談は労務担当に届きました" : "提出しました。おつかれさまでした");
    location.hash = "#/report/" + res.id;
  });
}

// ---- 履歴・詳細 ----

async function viewMine() {
  const rows = await api("/reports/mine");
  render(`
    <h1>自分の日報</h1>
    ${rows.length ? "" : `<p class="muted">まだ日報がありません。</p>`}
    ${rows
      .map(
        (r) => `<a class="card link" href="#/report/${r.id}">
          <div class="row"><b>${fmtDate(r.report_date)}</b> <span>${mood(r.condition).face}</span><span class="spacer"></span>
          <span class="muted">${r.like_count ? "👍" + r.like_count + " " : ""}${r.comment_count ? "💬" + r.comment_count : ""}</span></div>
          <div class="muted">${esc(r.done.slice(0, 80))}</div></a>`,
      )
      .join("")}`);
}

async function viewReport(id) {
  const { report: r, comments, readers } = await api("/reports/" + id);
  const mine = r.user_id === me.id;
  const section = (title, body) => (body ? `<h2>${title}</h2><div class="pre">${esc(body)}</div>` : "");
  const likes = comments.filter((c) => c.kind === "like");
  render(`
    <div class="card">
      <div class="row"><h1 style="margin:0">${esc(r.author_name)}　${fmtDate(r.report_date)}</h1></div>
      <p>今日の調子：<span style="font-size:1.4rem">${mood(r.condition).face}</span> ${mood(r.condition).label}${r.end_time ? `　退勤 ${esc(r.end_time)}` : ""}</p>
      ${section("今日やったこと", r.done)}
      ${section("今日もう一度やり直せるなら", r.redo)}
      ${section("気づき・成長の記録", r.growth)}
      ${section("明日の予定", r.plan)}
      ${section("経営計画書の気になる一文", r.kk)}
      ${mine ? `<p><a href="#/write/${r.report_date}">書き直す</a></p>` : ""}
      <p class="muted">${readers.length ? "既読：" + readers.map((x) => esc(x.name)).join("、") : "まだ誰も読んでいません"}</p>
    </div>
    <div class="card">
      <div class="row">
        <h2 style="margin:0">やりとり</h2><span class="spacer"></span>
        ${mine ? "" : `<button class="small" id="like">👍 見たよ</button>`}
        ${likes.length ? `<span class="muted">👍 ${likes.map((l) => esc(l.name)).join("、")}</span>` : ""}
      </div>
      ${comments
        .filter((c) => c.kind === "comment")
        .map((c) => `<div class="comment"><div class="who">${esc(c.name)} <span class="muted">${fmtTime(c.created_at)}</span></div><div class="pre">${esc(c.body)}</div></div>`)
        .join("") || `<p class="muted">まだコメントはありません。</p>`}
      <form id="f">
        <textarea name="body" placeholder="${mine ? "返信を書く" : "アドバイスや声かけを書く"}" required></textarea>
        <p class="error"></p>
        <button type="submit" class="primary">送信</button>
      </form>
    </div>`);
  onSubmit(document.getElementById("f"), async (d) => {
    await api(`/reports/${id}/comments`, { method: "POST", body: { body: d.body } });
    viewReport(id);
  });
  const like = document.getElementById("like");
  if (like) like.onclick = async () => {
    await api(`/reports/${id}/comments`, { method: "POST", body: { kind: "like" } });
    viewReport(id);
  };
}

// ---- チーム ----

async function viewTeam() {
  const date = sessionStorage.getItem("team_date") || today();
  const tid = isManager() ? `&tenant_id=${currentTenantId()}` : "";
  const data = await api(`/team/reports?date=${date}${tid}`);
  render(`
    <div class="row"><h1 style="margin:0">チームの日報</h1><span class="spacer"></span>
      <input type="date" id="d" value="${date}" max="${today()}" style="width:auto"></div>
    <p class="muted">提出 ${data.reports.length}人 ／ 未提出 ${data.missing.length}人</p>
    ${data.reports
      .map(
        (r) => `<a class="card link" href="#/report/${r.id}">
          <div class="row"><b>${esc(r.name)}</b> <span>${mood(r.condition).face}</span><span class="spacer"></span>
          ${r.is_read ? "" : `<span class="pill">未読</span>`} ${r.comment_count ? `<span class="muted">💬${r.comment_count}</span>` : ""}</div>
          <div class="muted">${esc(r.done.slice(0, 100))}</div></a>`,
      )
      .join("")}
    ${data.missing.length ? `<h2>未提出</h2><p>${data.missing.map((m) => esc(m.name)).join("、")}</p>` : ""}`);
  document.getElementById("d").onchange = (e) => {
    sessionStorage.setItem("team_date", e.target.value);
    viewTeam();
  };
}

// ---- 集計ダッシュボード ----

function lineChart(points, { min = 1, max = 5, bars } = {}) {
  // points: [{label, value|null}], bars: [{value, max}]（提出数）
  const W = 600, H = 140, P = 20;
  const n = points.length;
  const x = (i) => P + (i * (W - P * 2)) / Math.max(n - 1, 1);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - P * 2);
  const barSvg = bars
    ? bars.map((b, i) => {
        const h = b.max ? ((H - P * 2) * b.value) / b.max : 0;
        return `<rect class="bar" x="${x(i) - 8}" y="${H - P - h}" width="16" height="${h}"><title>${b.value}件</title></rect>`;
      }).join("")
    : "";
  const pts = points.map((p, i) => (p.value == null ? null : [x(i), y(p.value), p])).filter(Boolean);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("");
  const labels = points
    .map((p, i) => (i % Math.ceil(n / 7) === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${esc(p.label)}</text>` : ""))
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="推移グラフ">
    <line class="axis" x1="${P}" x2="${W - P}" y1="${y(3)}" y2="${y(3)}" stroke-dasharray="4 4"/>
    ${barSvg}<path class="line" d="${path}"/>
    ${pts.map((p) => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="3"><title>${esc(p[2].label)}：${p[2].value}</title></circle>`).join("")}
    ${labels}</svg>`;
}

async function viewDashboard() {
  const tenantId = currentTenantId();
  if (!tenantId) return render(`<p class="muted">担当の企業がありません。</p>`);
  const d = await api(`/dashboard?tenant_id=${tenantId}`);
  const last7 = d.days.slice(-7);
  const sub7 = last7.filter((x) => !["土", "日"].includes(fmtDate(x.date).slice(-2, -1)));
  const rate = d.members && sub7.length ? Math.round((sub7.reduce((s, x) => s + x.submitted, 0) / (d.members * sub7.length)) * 100) : 0;
  const avgOf = (xs) => {
    const v = xs.filter((x) => x.avg_condition != null);
    return v.length ? (v.reduce((s, x) => s + x.avg_condition, 0) / v.length).toFixed(1) : "-";
  };
  const st = Object.fromEntries(d.statuses.map((s) => [s.status, s.n]));
  render(`
    <h1>${esc(currentTenant()?.name || "")} の状態</h1>
    <div class="stats">
      <div class="stat"><span class="muted">日報の提出率（平日・直近7日）</span><b>${rate}%</b></div>
      <div class="stat"><span class="muted">平均の調子（直近7日）</span><b>${avgOf(last7)}</b><span class="muted">前週 ${avgOf(d.days.slice(0, 7))}</span></div>
      <div class="stat"><span class="muted">要フォロー・対応中</span><b>${(st.follow || 0) + (st.handling || 0)}人</b><span class="muted">全${d.members}人中</span></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h2 style="margin-top:0">平均の調子と提出数（14日）</h2>
      ${lineChart(d.days.map((x) => ({ label: x.date.slice(5).replace("-", "/"), value: x.avg_condition })), {
        bars: d.days.map((x) => ({ value: x.submitted, max: d.members })),
      })}
      <p class="muted">線が平均の調子（1〜5）、薄い棒が提出数です。個人の相談内容はここには表示されません。</p>
    </div>`);
}

// ---- 労務 ----

async function viewLabor() {
  const tenantId = currentTenantId();
  if (!tenantId) return render(`<p class="muted">担当の企業がありません。システム管理者に割り当てを依頼してください。</p>`);
  let tab = sessionStorage.getItem("labor_tab") || "alerts";
  const tabs = { alerts: "アラート", employees: "社員", consultations: "相談", keywords: "キーワード辞書" };
  render(`
    <div class="row"><h1 style="margin:0">労務管理</h1><span class="spacer"></span>
      <button class="small" id="run">今すぐ集計</button></div>
    <div class="row" style="margin:12px 0">${Object.entries(tabs)
      .map(([k, l]) => `<button class="small ${k === tab ? "primary" : ""}" data-tab="${k}">${l}</button>`)
      .join("")}</div>
    <div id="pane"></div>`);
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      sessionStorage.setItem("labor_tab", b.dataset.tab);
      viewLabor();
    }),
  );
  document.getElementById("run").onclick = async () => {
    const r = await api("/labor/run-detection", { method: "POST", body: {} });
    toast(`集計しました（新しいアラート ${r.created}件）`);
    viewLabor();
  };
  const pane = document.getElementById("pane");
  if (tab === "alerts") return paneAlerts(pane, tenantId);
  if (tab === "employees") return paneEmployees(pane, tenantId);
  if (tab === "consultations") return paneConsultations(pane, tenantId);
  return paneKeywords(pane, tenantId);
}

async function paneAlerts(pane, tenantId) {
  const status = sessionStorage.getItem("alert_status") || "open";
  const rows = await api(`/labor/alerts?tenant_id=${tenantId}&status=${status}`);
  pane.innerHTML = `
    <select id="st">${[["open", "未解決"], ...Object.entries(ALERT_STATUS), ["all", "すべて"]]
      .map(([k, l]) => `<option value="${k}" ${k === status ? "selected" : ""}>${l}</option>`)
      .join("")}</select>
    ${rows.length ? "" : `<p class="muted">該当するアラートはありません。</p>`}
    ${rows.map((a) => alertCard(a)).join("")}`;
  pane.querySelector("#st").onchange = (e) => {
    sessionStorage.setItem("alert_status", e.target.value);
    paneAlerts(pane, tenantId);
  };
  bindAlertCards(pane, () => paneAlerts(pane, tenantId));
}

function alertCard(a, withName = true) {
  return `<div class="card" data-alert="${a.id}">
    <div class="row"><span class="pill ${a.severity}">${SEV_LABEL[a.severity]}</span>
      <b>${KIND_LABEL[a.kind] || esc(a.kind)}</b>
      ${withName ? `<a href="#/labor/employee/${a.user_id}">${esc(a.user_name)}</a>` : ""}
      <span class="spacer"></span><span class="muted">${fmtTime(a.created_at)}</span></div>
    <p class="pre" style="margin:6px 0">${esc(a.detail)}</p>
    <div class="row">
      <select class="a-status">${Object.entries(ALERT_STATUS).map(([k, l]) => `<option value="${k}" ${k === a.status ? "selected" : ""}>${l}</option>`).join("")}</select>
      <input type="text" class="a-note" placeholder="対応メモ（任意）" style="flex:1;min-width:160px">
      <button class="small a-save">記録</button>
      <button class="small a-notes">履歴</button>
    </div>
    <div class="a-notes-list"></div>
  </div>`;
}

function bindAlertCards(root, reload) {
  root.querySelectorAll("[data-alert]").forEach((card) => {
    const id = card.dataset.alert;
    card.querySelector(".a-save").onclick = async () => {
      await api(`/labor/alerts/${id}`, {
        method: "PATCH",
        body: { status: card.querySelector(".a-status").value, note: card.querySelector(".a-note").value },
      });
      toast("記録しました");
      reload();
    };
    card.querySelector(".a-notes").onclick = async () => {
      const notes = await api(`/labor/alerts/${id}/notes`);
      card.querySelector(".a-notes-list").innerHTML = notes.length
        ? notes.map((n) => `<div class="comment"><span class="who">${esc(n.name)}</span> <span class="muted">${fmtTime(n.created_at)}</span><div class="pre">${esc(n.body)}</div></div>`).join("")
        : `<p class="muted">対応記録はまだありません。</p>`;
    };
  });
}

async function paneEmployees(pane, tenantId) {
  const rows = await api(`/labor/overview?tenant_id=${tenantId}`);
  pane.innerHTML = `<div class="table-wrap"><table>
    <tr><th>氏名</th><th>ステータス</th><th>調子（7日）</th><th>提出（7日）</th><th>最終提出</th><th>未解決</th></tr>
    ${rows
      .map((u) => {
        const trend = u.avg7 != null && u.avg_prev != null ? (u.avg7 - u.avg_prev <= -0.5 ? " ↓" : u.avg7 - u.avg_prev >= 0.5 ? " ↑" : "") : "";
        return `<tr>
          <td><a href="#/labor/employee/${u.id}">${esc(u.name)}</a><div class="muted">${esc(u.supervisor_name ? "上長：" + u.supervisor_name : "")}</div></td>
          <td><span class="pill st-${u.status}">${STATUS_LABEL[u.status]}</span></td>
          <td>${u.avg7 ?? "-"}${trend}</td>
          <td>${u.submitted7}日</td>
          <td>${fmtDate(u.last_report)}</td>
          <td>${u.open_alerts ? `<span class="pill mid">${u.open_alerts}</span>` : "-"}</td></tr>`;
      })
      .join("")}
  </table></div>`;
}

async function paneConsultations(pane, tenantId) {
  const rows = await api(`/labor/consultations?tenant_id=${tenantId}`);
  pane.innerHTML = rows.length
    ? rows
        .map((c) => `<div class="card"><div class="row"><a href="#/labor/employee/${c.user_id}"><b>${esc(c.user_name)}</b></a><span class="spacer"></span><span class="muted">${fmtTime(c.created_at)}</span></div>
          <div class="pre">${esc(c.body)}</div>${c.report_id ? `<a href="#/report/${c.report_id}" class="muted">その日の日報</a>` : ""}</div>`)
        .join("")
    : `<p class="muted">相談はまだありません。</p>`;
}

async function paneKeywords(pane, tenantId) {
  const rows = await api(`/labor/keywords?tenant_id=${tenantId}`);
  pane.innerHTML = `
    <p class="muted">日報や相談にこれらの言葉が含まれると、提出時にアラートが作られます。</p>
    <form id="kf" class="row">
      <input type="text" name="word" placeholder="言葉" required style="flex:1;min-width:120px">
      <select name="severity"><option value="low">低</option><option value="mid" selected>中</option><option value="high">高</option></select>
      ${me.role === "sysadmin" ? `<label style="margin:0;font-weight:400"><input type="checkbox" name="common"> 全社共通</label>` : ""}
      <button type="submit" class="primary small">追加</button>
      <span class="error"></span>
    </form>
    <div class="table-wrap"><table><tr><th>言葉</th><th>重要度</th><th>範囲</th><th></th></tr>
    ${rows
      .map((k) => {
        const editable = k.tenant_id !== null || me.role === "sysadmin";
        return `<tr><td>${esc(k.word)}</td><td><span class="pill ${k.severity}">${SEV_LABEL[k.severity]}</span></td>
          <td class="muted">${k.tenant_id === null ? "全社共通" : "この企業"}</td>
          <td>${editable ? `<button class="small" data-del="${k.id}">削除</button>` : ""}</td></tr>`;
      })
      .join("")}</table></div>`;
  onSubmit(pane.querySelector("#kf"), async (d) => {
    await api("/labor/keywords", { method: "POST", body: { ...d, tenant_id: tenantId, common: !!d.common } });
    paneKeywords(pane, tenantId);
  });
  pane.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("削除しますか？")) return;
    await api("/labor/keywords/" + b.dataset.del, { method: "DELETE" });
    paneKeywords(pane, tenantId);
  }));
}

async function viewEmployee(id) {
  const d = await api("/labor/employees/" + id);
  const u = d.user;
  const days = [];
  const byDate = new Map(d.reports.map((r) => [r.report_date, r]));
  for (let i = 59; i >= 0; i--) {
    const dt = new Date(Date.now() + 9 * 3600_000 - i * 86400_000).toISOString().slice(0, 10);
    days.push({ label: dt.slice(5).replace("-", "/"), value: byDate.get(dt)?.condition ?? null });
  }
  render(`
    <p><a href="#/labor">← 労務管理</a></p>
    <div class="card">
      <h1>${esc(u.name)}</h1>
      <p class="muted">${ROLE_LABEL[u.role]}${u.supervisor_name ? " ・ 上長：" + esc(u.supervisor_name) : ""} ・ ${esc(u.email)}</p>
      <form id="sf">
        <label>ステータス</label>
        <div class="row">
          <select name="status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${k === d.status.status ? "selected" : ""}>${l}</option>`).join("")}</select>
          <input type="text" name="note" placeholder="変更理由・メモ" value="${esc(d.status.note)}" style="flex:1;min-width:160px">
          <button type="submit" class="primary small">変更</button>
        </div>
        <p class="error"></p>
      </form>
      ${d.status.updated_at ? `<p class="muted">最終更新：${fmtTime(d.status.updated_at)} ${esc(d.status.updated_by_name || "")}</p>` : ""}
    </div>
    <div class="card">
      <h2 style="margin-top:0">調子の推移（60日）</h2>
      ${lineChart(days)}
    </div>
    <h2>アラート</h2>
    <div id="alerts">${d.alerts.length ? d.alerts.map((a) => alertCard(a, false)).join("") : `<p class="muted">アラートはありません。</p>`}</div>
    <h2>労務担当への相談</h2>
    ${d.consultations.length ? d.consultations.map((c) => `<div class="card"><span class="muted">${fmtTime(c.created_at)}</span><div class="pre">${esc(c.body)}</div></div>`).join("") : `<p class="muted">相談はありません。</p>`}
    <h2>直近の日報</h2>
    ${d.reports.slice(-10).reverse().map((r) => `<a class="card link" href="#/report/${r.id}"><b>${fmtDate(r.report_date)}</b> ${mood(r.condition).face}${r.end_time ? ` <span class="muted">退勤 ${esc(r.end_time)}</span>` : ""}<div class="muted">${esc(r.done.slice(0, 80))}</div></a>`).join("") || `<p class="muted">日報はありません。</p>`}
    <h2>ステータス変更履歴</h2>
    <div class="table-wrap"><table><tr><th>日時</th><th>変更</th><th>メモ</th><th>変更者</th></tr>
      ${d.history.map((h) => `<tr><td>${fmtTime(h.created_at)}</td><td>${STATUS_LABEL[h.old_status] || "-"} → ${STATUS_LABEL[h.new_status]}</td><td>${esc(h.note)}</td><td>${esc(h.changed_by_name)}</td></tr>`).join("")}
    </table></div>`);
  onSubmit(document.getElementById("sf"), async (f) => {
    await api(`/labor/employees/${id}/status`, { method: "PUT", body: f });
    toast("ステータスを変更しました");
    viewEmployee(id);
  });
  bindAlertCards(document.getElementById("alerts"), () => viewEmployee(id));
}

// ---- 管理 ----

// ---- 社員名簿 CSV の読み込み ----

let lastImport = null; // 直前の一括登録の結果（招待リンク付き）。画面を描き直しても残す

/** Excel で文字化けしない CSV（BOM 付き UTF-8）をダウンロードさせる */
function downloadCsv(filename, rows) {
  const cell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const blob = new Blob(["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** UTF-8 で読めなければ Shift_JIS（日本語版 Excel の既定）として読む */
async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

function importRowsTable(rows, withLinks) {
  return `<div class="table-wrap"><table>
    <tr><th>行</th><th>氏名</th><th>メールアドレス</th><th>役割</th><th>上長</th>${withLinks ? "<th>招待リンク</th>" : ""}</tr>
    ${rows.map((r) => `<tr><td>${r.line}</td><td style="white-space:nowrap">${esc(r.name)}</td><td>${esc(r.email)}</td><td style="white-space:nowrap">${ROLE_LABEL[r.role]}</td><td>${esc(r.supervisor_email || "")}</td>${withLinks ? `<td><div class="invite-url">${esc(r.invite_url)}</div></td>` : ""}</tr>`).join("")}
  </table></div>`;
}

function importResultHtml(res) {
  return `<p><b>${res.rows.length}人を登録しました。</b>招待リンク（7日間有効）を本人に送ってください。</p>
    <div class="row"><button type="button" class="primary" id="csv-links">招待リンクを CSV でダウンロード</button><button type="button" class="small" id="csv-close">閉じる</button></div>
    ${importRowsTable(res.rows, true)}`;
}

function bindCsvImport(tenant) {
  const box = document.getElementById("csv-result");
  const bindResult = () => {
    document.getElementById("csv-links")?.addEventListener("click", () =>
      downloadCsv("invite_links.csv", [["氏名", "メールアドレス", "役割", "招待リンク"], ...lastImport.rows.map((r) => [r.name, r.email, ROLE_LABEL[r.role], r.invite_url])]),
    );
    document.getElementById("csv-close")?.addEventListener("click", () => {
      lastImport = null;
      box.innerHTML = "";
    });
  };
  bindResult();
  document.getElementById("csv-template").onclick = () =>
    downloadCsv("employees_template.csv", [
      ["氏名", "メールアドレス", "役割", "上長のメールアドレス"],
      ["山田 太郎", "yamada@example.com", "社長", ""],
      ["佐藤 花子", "sato@example.com", "上長", ""],
      ["鈴木 一郎", "suzuki@example.com", "社員", "sato@example.com"],
    ]);
  document.getElementById("csv-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const csv = await readCsvFile(file);
    let check;
    try {
      check = await api("/admin/users/import", { method: "POST", body: { tenant_id: tenant.id, csv, dry_run: true } });
    } catch (ex) {
      return toast(ex.message);
    }
    if (!check.ok) {
      box.innerHTML = `<p class="error">${check.errors.length}件の問題があります。CSV を直してから、もう一度選んでください（まだ誰も登録していません）。</p>
        <ul>${check.errors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
      e.target.value = "";
      return;
    }
    box.innerHTML = `<p>${check.rows.length}人を登録します。内容を確認してください。</p>
      <div class="row"><button type="button" class="primary" id="csv-go">登録して招待リンクを発行</button><button type="button" class="small" id="csv-cancel">やめる</button><span class="error"></span></div>
      ${importRowsTable(check.rows, false)}`;
    document.getElementById("csv-cancel").onclick = () => {
      box.innerHTML = "";
      e.target.value = "";
    };
    document.getElementById("csv-go").onclick = async (ev) => {
      ev.target.disabled = true;
      try {
        const res = await api("/admin/users/import", { method: "POST", body: { tenant_id: tenant.id, csv } });
        if (!res.ok) throw new Error(res.errors.join(" / "));
        lastImport = res;
        toast(`${res.rows.length}人を登録しました`);
        await viewAdmin();
      } catch (ex) {
        ev.target.disabled = false;
        box.querySelector(".error").textContent = ex.message;
      }
    };
  };
}

async function viewAdmin() {
  const tenantId = currentTenantId();
  const tenant = isLabor() ? currentTenant() : (await api("/admin/tenants"))[0];
  const demo = me.role === "sysadmin" ? await api("/admin/demo") : { exists: false };
  const users = tenantId ? await api(`/admin/users?tenant_id=${tenantId}`) : [];
  const roleOptions = ["employee", "supervisor", "owner", ...(isLabor() ? ["labor"] : [])];
  const supOptions = (sel, exclude) =>
    `<option value="">（なし）</option>` +
    users.filter((u) => u.active && u.role !== "labor" && u.id !== exclude).map((u) => `<option value="${u.id}" ${u.id === sel ? "selected" : ""}>${esc(u.name)}</option>`).join("");
  const s = tenant?.settings || {};
  render(`
    <h1>管理</h1>
    ${me.role === "sysadmin" ? `
    <div class="card">
      <h2 style="margin-top:0">企業を追加</h2>
      <form id="tf" class="row"><input type="text" name="name" placeholder="企業名" required style="flex:1"><button type="submit" class="primary">追加</button><span class="error"></span></form>
    </div>
    <div class="card">
      <h2 style="margin-top:0">デモデータ</h2>
      ${demo.exists ? `
      <p class="muted">「デモ株式会社」が入っています（社員10人・約2ヶ月分）。消すと、デモ会社の日報・アラートなどもすべて消えます。</p>
      <button type="button" id="demo-clear">デモデータを消す</button>` : `
      <p class="muted">「デモ株式会社」（社長・上長2人・社員10人・労務担当）と、約2ヶ月分の日報・コメント・相談・アラートを入れます。デモユーザーは全員、下のパスワードでログインできます。</p>
      <form id="df" class="row"><input type="password" name="password" placeholder="デモユーザーのパスワード（10文字以上）" minlength="10" autocomplete="new-password" required style="flex:1"><button type="submit" class="primary">デモデータを入れる</button><span class="error"></span></form>`}
    </div>` : ""}
    ${tenant ? `
    <div class="card">
      <h2 style="margin-top:0">${esc(tenant.name)} の設定</h2>
      <form id="sf">
        <label style="font-weight:400"><input type="checkbox" name="showEndTime" ${s.showEndTime ? "checked" : ""}> 日報に「退勤時刻」欄を出す（長時間労働の検知に使います）</label>
        <label style="font-weight:400"><input type="checkbox" name="showKK" ${s.showKK ? "checked" : ""}> 日報に「経営計画書の気になる一文」欄を出す</label>
        <label>所定の終業時刻</label><input type="time" name="standardEnd" value="${esc(s.standardEnd || "17:30")}" style="width:auto">
        <p class="error"></p>
        <button type="submit" class="primary">保存</button>
      </form>
    </div>
    <div class="card">
      <h2 style="margin-top:0">ユーザーを招待</h2>
      <form id="uf">
        <label>氏名</label><input type="text" name="name" required>
        <label>メールアドレス</label><input type="email" name="email" required>
        <div class="row">
          <div><label>ロール</label><select name="role">${roleOptions.map((r) => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join("")}</select></div>
          <div><label>上長</label><select name="supervisor_id">${supOptions(null)}</select></div>
        </div>
        <p class="error"></p>
        <button type="submit" class="primary">招待リンクを発行</button>
      </form>
      <div id="invite"></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">CSV でまとめて登録</h2>
      <p class="muted">見出しが「氏名, メールアドレス, 役割, 上長のメールアドレス」の CSV を読み込みます。役割は 社員・上長・社長（空欄は社員）。上長は、同じ CSV の人か登録済みの人のメールアドレスで指定します。Excel で保存した CSV もそのまま使えます。</p>
      <div class="row">
        <button type="button" class="small" id="csv-template">ひな形をダウンロード</button>
        <input type="file" id="csv-file" accept=".csv,text/csv">
      </div>
      <div id="csv-result">${lastImport ? importResultHtml(lastImport) : ""}</div>
    </div>
    <h2>ユーザー一覧</h2>
    <div class="table-wrap"><table>
      <tr><th>氏名</th><th>ロール</th><th>上長</th><th>状態</th><th></th></tr>
      ${users
        .map((u) => `<tr data-user="${u.id}">
          <td>${esc(u.name)}<div class="muted">${esc(u.email)}</div></td>
          <td><select class="u-role">${[...new Set([...roleOptions, u.role])].map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select></td>
          <td><select class="u-sup">${supOptions(u.supervisor_id, u.id)}</select></td>
          <td>${u.active ? (u.activated ? "利用中" : `<span class="pill mid">未設定</span>`) : `<span class="muted">無効</span>`}</td>
          <td><div class="row">
            <button class="small u-save">保存</button>
            <button class="small u-invite">${u.activated ? "再設定リンク" : "招待リンク"}</button>
            <button class="small u-active">${u.active ? "無効にする" : "有効にする"}</button>
          </div></td></tr>`)
        .join("")}
    </table></div>` : `<p class="muted">企業がありません。上で追加してください。</p>`}`);

  const df = document.getElementById("df");
  if (df) onSubmit(df, async (d) => {
    await api("/admin/demo", { method: "POST", body: d });
    laborTenants = await api("/labor/tenants");
    toast("デモデータを入れました");
    route();
  });
  document.getElementById("demo-clear")?.addEventListener("click", async () => {
    if (!confirm("デモ株式会社のデータをすべて消します。よろしいですか？")) return;
    try {
      await api("/admin/demo", { method: "DELETE" });
    } catch (ex) {
      return toast(ex.message);
    }
    laborTenants = await api("/labor/tenants");
    try { localStorage.removeItem("tenant_id"); } catch {}
    toast("デモデータを消しました");
    route();
  });
  const tf = document.getElementById("tf");
  if (tf) onSubmit(tf, async (d) => {
    const t = await api("/admin/tenants", { method: "POST", body: d });
    laborTenants = await api("/labor/tenants");
    try { localStorage.setItem("tenant_id", t.id); } catch {}
    toast("企業を追加しました");
    route();
  });
  if (!tenant) return;
  onSubmit(document.getElementById("sf"), async (d) => {
    await api(`/admin/tenants/${tenant.id}`, {
      method: "PATCH",
      body: { settings: { showEndTime: !!d.showEndTime, showKK: !!d.showKK, standardEnd: d.standardEnd } },
    });
    await loadMe();
    toast("保存しました");
  });
  const showInvite = (url, name) => {
    document.getElementById("invite").innerHTML = `<p>${esc(name)} さんにこのリンクを送ってください（7日間有効）。</p>
      <div class="invite-url">${esc(url)}</div><button class="small" id="copy" style="margin-top:6px">コピー</button>`;
    document.getElementById("copy").onclick = () => navigator.clipboard.writeText(url).then(() => toast("コピーしました"));
    document.getElementById("invite").scrollIntoView({ behavior: "smooth" });
  };
  bindCsvImport(tenant);
  onSubmit(document.getElementById("uf"), async (d) => {
    const res = await api("/admin/users", { method: "POST", body: { ...d, tenant_id: tenant.id } });
    await viewAdmin();
    showInvite(res.invite_url, d.name);
  });
  document.querySelectorAll("[data-user]").forEach((tr) => {
    const id = tr.dataset.user;
    const u = users.find((x) => String(x.id) === id);
    const save = (extra = {}) =>
      api(`/admin/users/${id}`, {
        method: "PATCH",
        body: { role: tr.querySelector(".u-role").value, supervisor_id: tr.querySelector(".u-sup").value || null, active: !!u.active, ...extra },
      });
    tr.querySelector(".u-save").onclick = async () => {
      try { await save(); toast("保存しました"); viewAdmin(); } catch (e) { toast(e.message); }
    };
    tr.querySelector(".u-active").onclick = async () => {
      if (u.active && !confirm(`${u.name} さんを無効にしますか？ログインできなくなります。`)) return;
      try { await save({ active: !u.active }); viewAdmin(); } catch (e) { toast(e.message); }
    };
    tr.querySelector(".u-invite").onclick = async () => {
      try {
        const res = await api(`/admin/users/${id}/invite`, { method: "POST", body: {} });
        showInvite(res.invite_url, u.name);
      } catch (e) { toast(e.message); }
    };
  });
}

// ---- 起動 ----

(async () => {
  await loadMe();
  route();
})();
