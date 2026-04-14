/**
 * F0 Context Generator — Apps Script
 *
 * Читает существующие "красивые" листы трекера Geonline
 * и генерирует скрытые машиночитаемые листы для бота:
 *   _stakeholder_map — участники, роли, BSC, ответственность
 *   _okr — OKR/KR с владельцами и статусами
 *   _f5_metrics — leading/lagging метрики (заполняется вручную)
 *
 * Запуск: меню "F0 Context" → "Обновить F0" или onEdit триггер.
 */

// === Config ===

const SOURCE_OKR_SHEET = "📊 ВСЕ OKR";
const STAKEHOLDER_MAP_SHEET = "_stakeholder_map";
const OKR_SHEET = "_okr";
const F5_METRICS_SHEET = "_f5_metrics";

// Row/col ranges in source (1-based, from screenshot analysis)
const PARTICIPANTS_START_ROW = 11; // Row with first participant (Самарханов)
const PARTICIPANTS_HEADER_ROW = 10; // Header row: №, Участник, Должность, BSC, Ответственность
const OKR_DETAIL_START_ROW = 22; // "ДЕТАЛЬНЫЙ СПИСОК ВСЕХ OKR И KEY RESULTS"

// Top-manager sheet structure
const TOP_SHEET_POSITION_ROW = 2; // "Должность:" in col A, value in col B
const TOP_SHEET_BSC_ROW = 3;
const TOP_SHEET_RESPONSIBILITY_ROW = 4;
const TOP_SHEET_KR_HEADER_ROW = 10;

// Known top-manager sheet names (from tab bar)
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

// === Menu ===

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("F0 Context")
    .addItem("Обновить F0", "generateF0")
    .addItem("Показать скрытые листы", "showHiddenSheets")
    .addItem("Скрыть F0 листы", "hideF0Sheets")
    .addToUi();
}

// === Main ===

function generateF0() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  generateStakeholderMap(ss);
  generateOKR(ss);
  ensureF5MetricsSheet(ss);

  SpreadsheetApp.getUi().alert(
    "F0 Context обновлён ✅\n\n" +
    "Листы: _stakeholder_map, _okr, _f5_metrics\n" +
    "Скрыть: меню F0 Context → Скрыть F0 листы"
  );
}

// === Stakeholder Map ===

function generateStakeholderMap(ss) {
  const source = ss.getSheetByName(SOURCE_OKR_SHEET);
  if (!source) throw new Error(`Лист "${SOURCE_OKR_SHEET}" не найден`);

  // Read participants block (rows 11-19 based on screenshot: 9 people)
  // Columns: A=№, B=Участник, C=Должность, D=BSC, E=Ответственность
  // Stop at first empty row in column A (№) — separates participants from OKR detail below
  const lastParticipantRow = findLastContiguousRow(source, 1, PARTICIPANTS_START_ROW, 20);
  const data = source.getRange(PARTICIPANTS_START_ROW, 1, lastParticipantRow - PARTICIPANTS_START_ROW + 1, 5).getValues();

  const rows = data
    .filter(row => row[1] && String(row[1]).trim() !== "")
    .map(row => {
      const fullName = String(row[1]).trim();
      // speaker_name = фамилия (первое слово)
      const speakerName = fullName.split(" ")[0];
      return [
        fullName,
        speakerName,
        String(row[2]).trim(), // department/position
        "", // role — same as position for now
        String(row[3]).trim(), // bsc_category
        String(row[4]).trim(), // responsibility (OKR ownership)
        "", // interests — to be filled
        "", // notes
      ];
    });

  const headers = [
    "full_name",
    "speaker_name",
    "department",
    "role",
    "bsc_category",
    "responsibility_areas",
    "interests",
    "notes",
  ];

  writeSheet(ss, STAKEHOLDER_MAP_SHEET, headers, rows);
}

// === OKR ===

function generateOKR(ss) {
  const rows = [];

  // Iterate over each top-manager sheet to extract KRs with context
  for (const sheetName of TOP_SHEETS) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) continue;

    // Read header info
    const position = sheet.getRange(TOP_SHEET_POSITION_ROW, 2).getValue();
    const bsc = sheet.getRange(TOP_SHEET_BSC_ROW, 2).getValue();
    const responsibility = sheet.getRange(TOP_SHEET_RESPONSIBILITY_ROW, 2).getValue();

    // Read KR table (starting at row 10: header, data from row 11)
    // Stop at first empty row — separates KR block from "АКТИВНЫЙ ТРЕКИНГ" below
    const lastRow = findLastContiguousRow(sheet, 1, TOP_SHEET_KR_HEADER_ROW + 1, 30);
    if (lastRow <= TOP_SHEET_KR_HEADER_ROW) continue;

    // Columns: A=№ KR, B=Краткое название, C=Ключевой результат, D=Текущий статус, E=Целевая метрика, F=Прогресс, G=Срок
    const krData = sheet.getRange(TOP_SHEET_KR_HEADER_ROW + 1, 1, lastRow - TOP_SHEET_KR_HEADER_ROW, 7).getValues();

    for (const kr of krData) {
      const krNumber = String(kr[0]).trim();
      if (!krNumber || krNumber === "") continue;

      rows.push([
        krNumber,                          // kr_number
        String(kr[1]).trim(),              // short_name
        String(kr[2]).trim(),              // key_result
        sheetName,                         // owner
        String(position).trim(),           // owner_position
        String(kr[3]).trim(),              // current_status
        String(kr[4]).trim(),              // target
        String(kr[5]).trim(),              // progress
        String(kr[6]).trim(),              // deadline
        String(responsibility).trim(),     // okr_group
        "Q2 2026",                         // quarter
      ]);
    }
  }

  const headers = [
    "kr_number",
    "short_name",
    "key_result",
    "owner",
    "owner_position",
    "current_status",
    "target",
    "progress",
    "deadline",
    "okr_group",
    "quarter",
  ];

  writeSheet(ss, OKR_SHEET, headers, rows);
}

// === F5 Metrics ===

function ensureF5MetricsSheet(ss) {
  let sheet = ss.getSheetByName(F5_METRICS_SHEET);
  if (sheet) return; // already exists, don't overwrite manual data

  const headers = [
    "department",
    "metric_name",
    "metric_type",  // leading | lagging
    "unit",
    "source",       // CRM | Sheets | manual
    "owner_speaker_name",
    "ranges",       // JSON array for Telegram inline buttons
    "update_frequency",
    "risk_notes",
    "notes",
  ];

  // Pre-populate departments from stakeholder map
  const stakeholders = ss.getSheetByName(STAKEHOLDER_MAP_SHEET);
  const departments = [];
  if (stakeholders) {
    const data = stakeholders.getDataRange().getValues();
    const seen = new Set();
    for (let i = 1; i < data.length; i++) {
      const dept = String(data[i][2]).trim();
      if (dept && !seen.has(dept)) {
        seen.add(dept);
        // Two rows per department: leading + lagging
        departments.push([dept, "", "leading", "", "", "", "", "", "", ""]);
        departments.push([dept, "", "lagging", "", "", "", "", "", "", ""]);
      }
    }
  }

  writeSheet(ss, F5_METRICS_SHEET, headers, departments);
}

// === Utilities ===

function writeSheet(ss, name, headers, rows) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    sheet.clearContents();
  } else {
    sheet = ss.insertSheet(name);
  }

  // Write headers
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");

  // Write data
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Auto-resize
  for (let i = 1; i <= headers.length; i++) {
    sheet.autoResizeColumn(i);
  }
}

function findLastRowInColumn(sheet, col, startRow, maxScan) {
  const values = sheet.getRange(startRow, col, maxScan, 1).getValues();
  let lastRow = startRow - 1;
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] !== "" && values[i][0] !== null) {
      lastRow = startRow + i;
    }
  }
  return lastRow;
}

// Stops at first empty cell (contiguous block only)
function findLastContiguousRow(sheet, col, startRow, maxScan) {
  const values = sheet.getRange(startRow, col, maxScan, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === "" || values[i][0] === null) {
      return startRow + i - 1;
    }
  }
  return startRow + values.length - 1;
}

function showHiddenSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of [STAKEHOLDER_MAP_SHEET, OKR_SHEET, F5_METRICS_SHEET]) {
    const sheet = ss.getSheetByName(name);
    if (sheet) sheet.showSheet();
  }
}

function hideF0Sheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of [STAKEHOLDER_MAP_SHEET, OKR_SHEET, F5_METRICS_SHEET]) {
    const sheet = ss.getSheetByName(name);
    if (sheet) sheet.hideSheet();
  }
}
