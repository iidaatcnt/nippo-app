import { describe, expect, it } from "vitest";
import { parseCsv, parseRoster } from "../src/csv";

describe("CSV", () => {
  it("引用符・改行・BOM・CRLF を扱える", () => {
    expect(parseCsv('﻿a,"b,c","d""e"\r\n"f\ng",h\r\n')).toEqual([["a", "b,c", 'd"e'], ["f\ng", "h"]]);
  });
  it("空行は無視する", () => {
    expect(parseCsv("a,b\n\n,\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
  });
});

describe("社員名簿", () => {
  const head = "氏名,メールアドレス,役割,上長のメールアドレス\n";
  it("見出しの名前で列を探し、役割を変換する", () => {
    const { rows, errors } = parseRoster("メール,名前\nTaro@Example.com,山田 太郎\n");
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ line: 2, name: "山田 太郎", email: "taro@example.com", role: "employee", supervisorEmail: "" });
    expect(parseRoster(head + "佐藤,sato@example.com,上長,\n").rows[0].role).toBe("supervisor");
  });
  it("誤りを行番号つきで返す", () => {
    const { errors } = parseRoster(head + ",bad,部長,\n鈴木,a@example.com,社員,a@example.com\n田中,a@example.com,,\n");
    expect(errors).toEqual([
      "2行目: 氏名がありません",
      "2行目: メールアドレスの形式が正しくありません（bad）",
      "2行目: 役割「部長」は使えません（社員・上長・社長のいずれか）",
      "3行目: 自分自身を上長にはできません",
      "4行目: メールアドレスが 3行目と重複しています",
    ]);
  });
  it("見出しがなければエラー", () => {
    expect(parseRoster("a,b\nc,d\n").errors[0]).toContain("見出し");
  });
});
