/**
 * Extract OKR + Stakeholder Map from Geonline xlsx → JSON
 *
 * Зеркало логики sheets/Code.js (generateF0), но локально через xlsx package.
 * Не требует Apps Script. Использует тот же лист "📊 ВСЕ OKR" + per-manager sheets.
 *
 * Использование:
 *   npx tsx scripts/extract-okr-from-xlsx.ts
 *
 * Вход: "Geonline  Стратегический трекинг v2.0 (14).xlsx" (в корне)
 * Выход: data/okr-context.json + data/stakeholder-map.json
 */

import * as XLSX from "xlsx";
import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOP_SHEETS = [
  "Самарханов",
  "Тоқтағазинов",
  "Жүсіпбек",
  "Койгельдина",
  "Фархатов",
  "Мурсалимова",
  "Тұрар",
  "Мухаметова",
  "Бектегенова",
];

const SOURCE_OKR_SHEET = "📊 ВСЕ OKR";
const PARTICIPANTS_START_ROW = 11; // 1-based
const PARTICIPANTS_HEADERS_COL_COUNT = 5; // A-E
const TOP_SHEET_KR_HEADER_ROW = 10; // 1-based, data from row 11

// Find xlsx file in project root (whitespace + parens make it fragile)
function findXlsxFile(): string {
  const root = process.cwd();
  const matches = readdirSync(root).filter(f => f.toLowerCase().endsWith(".xlsx"));
  if (matches.length === 0) throw new Error("xlsx файл не найден в корне");
  if (matches.length > 1) {
    console.warn(`⚠️  Найдено ${matches.length} xlsx файлов. Использую первый: ${matches[0]}`);
  }
  return join(root, matches[0]!);
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function readRow(sheet: XLSX.WorkSheet, row: number, colCount: number): unknown[] {
  const cells: unknown[] = [];
  for (let c = 0; c < colCount; c++) {
    const addr = XLSX.utils.encode_cell({ r: row - 1, c });
    cells.push(sheet[addr]?.v);
  }
  return cells;
}

function extractStakeholders(wb: XLSX.WorkBook): Array<Record<string, string>> {
  const sheet = wb.Sheets[SOURCE_OKR_SHEET];
  if (!sheet) throw new Error(`Лист "${SOURCE_OKR_SHEET}" не найден`);

  const rows: Array<Record<string, string>> = [];

  // Read participants block — stop at first empty col-A row
  for (let r = PARTICIPANTS_START_ROW; r < PARTICIPANTS_START_ROW + 30; r++) {
    const row = readRow(sheet, r, PARTICIPANTS_HEADERS_COL_COUNT);
    const numCell = cellToString(row[0]);
    const nameCell = cellToString(row[1]);

    if (!numCell && !nameCell) break;
    if (!nameCell) continue;

    const fullName = nameCell;
    const speakerName = fullName.split(" ")[0]!;
    rows.push({
      full_name: fullName,
      speaker_name: speakerName,
      department: cellToString(row[2]),
      role: "",
      bsc_category: cellToString(row[3]),
      responsibility_areas: cellToString(row[4]),
      interests: "",
      notes: "",
    });
  }

  return rows;
}

function extractOKR(wb: XLSX.WorkBook): Array<Record<string, string>> {
  const krs: Array<Record<string, string>> = [];

  for (const sheetName of TOP_SHEETS) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      console.log(`  ⚠️  Лист "${sheetName}" отсутствует — пропуск`);
      continue;
    }

    // Header info
    const positionCell = sheet[XLSX.utils.encode_cell({ r: 1, c: 1 })]?.v; // B2
    const responsibilityCell = sheet[XLSX.utils.encode_cell({ r: 3, c: 1 })]?.v; // B4
    const position = cellToString(positionCell);
    const responsibility = cellToString(responsibilityCell);

    // KR data from row 11 (0-indexed: 10), 7 cols (A-G)
    let krsAdded = 0;
    for (let r = TOP_SHEET_KR_HEADER_ROW + 1; r < TOP_SHEET_KR_HEADER_ROW + 30; r++) {
      const row = readRow(sheet, r, 7);
      const krNumber = cellToString(row[0]);

      if (!krNumber) break; // empty col A → end of KR block

      krs.push({
        kr_number: krNumber,
        short_name: cellToString(row[1]),
        key_result: cellToString(row[2]),
        owner: sheetName,
        owner_position: position,
        current_status: cellToString(row[3]),
        target: cellToString(row[4]),
        progress: cellToString(row[5]),
        deadline: cellToString(row[6]),
        okr_group: responsibility,
        quarter: "Q2 2026",
      });
      krsAdded++;
    }

    console.log(`  ✅ ${sheetName} (${position || "—"}): ${krsAdded} KR`);
  }

  return krs;
}

function main() {
  console.log("🎯 Extract OKR + Stakeholder Map from xlsx\n");

  const xlsxPath = findXlsxFile();
  console.log(`📂 Файл: ${xlsxPath}\n`);

  const buf = readFileSync(xlsxPath);
  const wb = XLSX.read(buf, { type: "buffer" });
  console.log(`📊 Листов: ${wb.SheetNames.length}\n`);

  console.log("👥 Stakeholders:");
  const stakeholders = extractStakeholders(wb);
  console.log(`  ✅ ${stakeholders.length} участников\n`);

  console.log("🎯 OKR:");
  const krs = extractOKR(wb);
  console.log(`\n  ✅ Итого: ${krs.length} KR\n`);

  // Write outputs
  const okrOut = {
    _source: xlsxPath,
    _extracted: new Date().toISOString(),
    krs,
  };
  writeFileSync(join(process.cwd(), "data", "okr-context.json"), JSON.stringify(okrOut, null, 2));
  writeFileSync(join(process.cwd(), "data", "stakeholder-map.json"), JSON.stringify(stakeholders, null, 2));

  console.log("💾 Сохранено:");
  console.log("  data/okr-context.json");
  console.log("  data/stakeholder-map.json");
}

main();
