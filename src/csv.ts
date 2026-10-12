// 社員名簿 CSV の読み込み
// 1行目は見出し。列: 氏名, メールアドレス, 役割（社員/上長/社長、空欄は社員）, 上長のメールアドレス（任意）

/** RFC 4180 形式の CSV を行の配列にする（ダブルクォート・改行入りの値・CRLF・BOM に対応） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

export type RosterRole = "employee" | "supervisor" | "owner";

export interface RosterRow {
  line: number; // CSV の行番号（見出しが1行目）
  name: string;
  email: string;
  role: RosterRole;
  supervisorEmail: string;
}

const HEADERS: Record<keyof Omit<RosterRow, "line">, string[]> = {
  name: ["氏名", "名前", "name"],
  email: ["メールアドレス", "メール", "email"],
  role: ["役割", "ロール", "role"],
  supervisorEmail: ["上長のメールアドレス", "上長メールアドレス", "上長メール", "上長", "supervisor_email"],
};

const ROLES: Record<string, RosterRole> = {
  "": "employee", 社員: "employee", 一般: "employee", employee: "employee",
  上長: "supervisor", 管理職: "supervisor", supervisor: "supervisor",
  社長: "owner", 経営者: "owner", owner: "owner",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_ROSTER_ROWS = 200;

/** 名簿 CSV を読み、行ごとの内容と、CSV だけで分かる誤りを返す */
export function parseRoster(text: string): { rows: RosterRow[]; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (!table.length) return { rows: [], errors: ["CSV が空です"] };
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = {} as Record<keyof typeof HEADERS, number>;
  for (const key of Object.keys(HEADERS) as (keyof typeof HEADERS)[]) {
    col[key] = head.findIndex((h) => HEADERS[key].includes(h));
  }
  if (col.name < 0 || col.email < 0) return { rows: [], errors: ["1行目に「氏名」と「メールアドレス」の見出しが必要です"] };
  if (table.length - 1 > MAX_ROSTER_ROWS) return { rows: [], errors: [`一度に登録できるのは ${MAX_ROSTER_ROWS} 人までです`] };

  const rows: RosterRow[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k: keyof typeof HEADERS) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() : "");
    const name = get("name").slice(0, 100);
    const email = get("email").toLowerCase();
    const roleText = get("role");
    const supervisorEmail = get("supervisorEmail").toLowerCase();
    const role = ROLES[roleText] ?? ROLES[roleText.toLowerCase()];
    if (!name) errors.push(`${line}行目: 氏名がありません`);
    if (!EMAIL_RE.test(email)) errors.push(`${line}行目: メールアドレスの形式が正しくありません（${email || "空欄"}）`);
    if (!role) errors.push(`${line}行目: 役割「${roleText}」は使えません（社員・上長・社長のいずれか）`);
    if (supervisorEmail && supervisorEmail === email) errors.push(`${line}行目: 自分自身を上長にはできません`);
    if (seen.has(email)) errors.push(`${line}行目: メールアドレスが ${seen.get(email)}行目と重複しています`);
    else if (email) seen.set(email, line);
    rows.push({ line, name, email, role: role ?? "employee", supervisorEmail });
  });
  if (!rows.length) errors.push("2行目以降に社員がいません");
  return { rows, errors };
}
