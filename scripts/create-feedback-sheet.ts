#!/usr/bin/env tsx
/**
 * Одноразовое создание таблицы обратной связи (#баг/#фича/#хочу из группы).
 *
 * Создаёт spreadsheet с листом «Обратная связь», шапкой, выпадающим списком статуса,
 * закреплённой жирной шапкой; шарит на F0_SHEETS_SHARE_EMAILS + сервис-аккаунт.
 * Печатает spreadsheetId — его надо положить в .env как FEEDBACK_SHEET_ID и рестартнуть бота.
 *
 * Запуск (на проде, где заданы OAuth-креды):
 *   npx tsx scripts/create-feedback-sheet.ts
 */
import 'dotenv/config';
import { createSheetsWriteClient } from '../src/adapters/sheets.js';
import { createDriveWriteClient } from '../src/adapters/drive.js';
import { config } from '../src/config.js';
import {
  isGoogleOAuthConfigured,
  loadServiceAccountCredentials,
} from '../src/utils/google-auth.js';
import {
  FEEDBACK_HEADER,
  FEEDBACK_SHEET_TITLE,
  FEEDBACK_STATUSES,
} from '../src/feedback.js';

async function main(): Promise<void> {
  const sheets = await createSheetsWriteClient();
  const drive = await createDriveWriteClient();

  // 1. Создать spreadsheet с одним листом «Обратная связь».
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'Обратная связь по боту-трекеру' },
      sheets: [{ properties: { title: FEEDBACK_SHEET_TITLE, gridProperties: { frozenRowCount: 1 } } }],
    },
  });
  const sid = created.data.spreadsheetId;
  if (!sid) throw new Error('spreadsheets.create вернул пустой spreadsheetId');
  const sheetId = created.data.sheets?.[0]?.properties?.sheetId ?? 0;

  // 2. Шапка.
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${FEEDBACK_SHEET_TITLE}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[...FEEDBACK_HEADER]] },
  });

  // 3. Жирная шапка + выпадающий список статуса (колонка E, index 4) на строки 2..1000.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 4, endColumnIndex: 5 },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: FEEDBACK_STATUSES.map((v) => ({ userEnteredValue: v })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ],
    },
  });

  // 4. Доступ writer: сервис-аккаунт (если OAuth-режим) + трекеры из F0_SHEETS_SHARE_EMAILS.
  const shareTargets: string[] = [];
  if (isGoogleOAuthConfigured()) {
    const creds = await loadServiceAccountCredentials();
    shareTargets.push(creds.client_email);
  }
  for (const email of config.F0_SHEETS_SHARE_EMAILS.split(',').map((e) => e.trim()).filter(Boolean)) {
    shareTargets.push(email);
  }
  for (const emailAddress of shareTargets) {
    await drive.permissions.create({
      fileId: sid,
      supportsAllDrives: true,
      sendNotificationEmail: false,
      requestBody: { type: 'user', role: 'writer', emailAddress },
    });
  }

  const url = `https://docs.google.com/spreadsheets/d/${sid}/edit`;
  console.log('\n✅ Таблица обратной связи создана.');
  console.log(`FEEDBACK_SHEET_ID=${sid}`);
  console.log(`URL: ${url}`);
  console.log(`Доступ выдан: ${shareTargets.join(', ') || '(только владелец OAuth)'}\n`);
}

main().catch((err: unknown) => {
  console.error('Ошибка создания таблицы обратной связи:', err);
  process.exit(1);
});
