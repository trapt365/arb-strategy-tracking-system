# Story 0.1: Валидация провайдера транскрипции (Soniox)

Status: in-progress

## Story

As a **аналитик практики (Тимур)**,
I want **протестировать Soniox на worst-case записях и оценить стабильность API**,
So that **я могу принять Go/No-Go решение по провайдеру до начала разработки**.

## Acceptance Criteria

1. **Given** 5+ записей разных типов (1:1, групповая, code-switching каз-рус, шум, короткая < 15 мин)
   **When** каждая обработана через Soniox async file transcription API
   **Then** WER < 15% на наихудший сценарий
   **And** code-switching русский↔казахский распознаётся корректно (проверка на ≥ 3 записях с казахскими вставками)
   **And** формат API ответа задокументирован (JSON: tokens с speaker, language, timestamps)
   **And** rate limits, uptime за 3 месяца, стабильность формата проверены

2. **Given** поток нативной записи Google Meet
   **When** Азиза записывает тестовую сессию → файл в Google Drive → ссылка передана вручную
   **Then** аудиофайл скачивается по Google Drive API / share link
   **And** формат файла совместим с Soniox API (проверка: webm/mp4/m4a от Google Meet)
   **And** полный поток (запись → скачивание → транскрипция → JSON) завершается < 5 мин для 30-мин записи

3. **Given** Soniox не проходит порог
   **When** результаты оценены
   **Then** `/upload` raw copy-paste валидирован как primary path с friction < 2 мин
   **And** Plan C (собственная запись → Whisper/AssemblyAI) оценён по feasibility

## Tasks / Subtasks

- [ ] Task 1: Подготовка тестовой среды (AC: #1)
  - [ ] 1.1 Создать аккаунт Soniox, получить API key через console.soniox.com
  - [x] 1.2 Установить Node.js SDK: TypeScript + tsx (REST API напрямую вместо устаревшего gRPC SDK)
  - [x] 1.3 Написать тестовый скрипт `scripts/soniox-test.ts` для отправки аудио и получения результата
  - [ ] 1.4 Собрать 5+ тестовых записей: 1:1 чистая, групповая (3+ участника), code-switching рус↔каз, шумная запись, короткая < 15 мин

- [ ] Task 2: Тест API и качества транскрипции (AC: #1)
  - [ ] 2.1 Прогнать каждую запись через Soniox async API (модель `stt-async-v4`)
  - [ ] 2.2 Параметры: `enable_speaker_diarization: true`, `enable_language_identification: true`, `language_hints: ["ru", "kk"]`
  - [ ] 2.3 Измерить WER вручную на worst-case записи (шум + code-switching): целевой порог < 15%
  - [ ] 2.4 Проверить корректность code-switching: tokens с `language: "ru"` и `language: "kk"` соответствуют реальности
  - [ ] 2.5 Проверить diarization: speakers правильно разделены (1:1 = 2 speaker, групповая = 3+)
  - [ ] 2.6 Задокументировать формат ответа и маппинг на Transcript Interface Contract

- [ ] Task 3: Тест потока Google Meet → Soniox (AC: #2)
  - [ ] 3.1 Азиза записывает тестовую сессию в Google Meet (нативная запись)
  - [ ] 3.2 Проверить формат файла в Google Drive (ожидается webm или mp4)
  - [ ] 3.3 Скачать файл по share link (проверить: direct download vs Google Drive API)
  - [ ] 3.4 Отправить скачанный файл в Soniox API (проверить совместимость формата)
  - [ ] 3.5 Замерить полное время: запись → GDrive → скачивание → транскрипция → JSON (цель: < 5 мин для 30-мин записи)
  - [ ] 3.6 Если Zoom используется — аналогичный тест с Zoom Cloud recording

- [ ] Task 4: Webhook тест (AC: #1)
  - [ ] 4.1 Поднять временный endpoint (ngrok или аналог) для webhook
  - [ ] 4.2 Создать транскрипцию с `webhook_url` и `webhook_auth_header_*`
  - [ ] 4.3 Убедиться: webhook приходит при `completed` и `error` статусах
  - [ ] 4.4 Задокументировать payload и latency webhook

- [ ] Task 5: Оценка стабильности API (AC: #1)
  - [ ] 5.1 Проверить доступность API в разное время суток (утро, вечер Алматы)
  - [ ] 5.2 Проверить поведение при невалидном файле (пустой, битый, слишком длинный)
  - [ ] 5.3 Зафиксировать rate limits (если есть) и лимит размера файла (документирован: 1 GB)
  - [ ] 5.4 Проверить ценообразование в console.soniox.com, сравнить с бюджетом $0-30/мес

- [ ] Task 6: Валидация fallback `/upload` (AC: #3)
  - [ ] 6.1 Симулировать ручной copy-paste транскрипта в формат plain text
  - [ ] 6.2 Замерить friction: время от конца встречи до готового текста (цель: < 2 мин)
  - [ ] 6.3 Оценить Plan C (Whisper/AssemblyAI) по feasibility если Soniox не проходит

- [ ] Task 7: Документация результатов и Go/No-Go решение (AC: #1, #2, #3)
  - [ ] 7.1 Заполнить таблицу результатов: запись × WER × diarization × code-switching × время
  - [ ] 7.2 Сформулировать Go/No-Go решение с обоснованием
  - [ ] 7.3 Если Go → задокументировать маппинг Soniox response → Transcript Interface Contract
  - [ ] 7.4 Сохранить лучшие записи как основу для golden dataset (≥ 5 штук для Story 0.3)

## Dev Notes

### Контекст решения

Soniox выбран после сравнения 4 провайдеров (Soniox, Deepgram, MyMeet.ai, Timelist.ru). Единственный, кто поддерживает русский + казахский + автоматический code-switching. Цена ~$0.10/час.

**Это Gate story** — результат определяет Go/No-Go для всего проекта. Если WER > 15% на worst case → стоп-сигнал (критический критерий остановки из PRD).

### Soniox API — ключевая техническая информация

**Base URL:** `https://api.soniox.com/v1`
**Auth:** Bearer token: `Authorization: Bearer {SONIOX_API_KEY}`
**Модель:** `stt-async-v4` (текущая стабильная)

**Async workflow:**
1. Upload файл: `POST /files` (multipart, max 1 GB) или передать `audio_url` в запросе
2. Создать транскрипцию: `POST /transcriptions` с параметрами
3. Poll статус: `GET /transcriptions/{id}` или webhook
4. Получить результат: `GET /transcriptions/{id}/transcript`

**Ключевые параметры запроса:**
```json
{
  "model": "stt-async-v4",
  "enable_speaker_diarization": true,
  "enable_language_identification": true,
  "language_hints": ["ru", "kk"],
  "webhook_url": "https://...",
  "webhook_auth_header_name": "Authorization",
  "webhook_auth_header_value": "Bearer <secret>"
}
```

**Формат ответа (tokens):**
```json
{
  "id": "uuid",
  "text": "полный текст",
  "tokens": [
    {
      "text": "Привет",
      "start_ms": 0,
      "end_ms": 450,
      "confidence": 0.97,
      "speaker": "1",
      "language": "ru",
      "is_audio_event": false
    }
  ]
}
```

**Поддерживаемые форматы:** aac, aiff, amr, asf, flac, mp3, ogg, wav, webm, m4a, mp4 — все три целевых формата (webm, mp4, m4a от Google Meet/Zoom) поддерживаются нативно.

**Node.js SDK:** `@soniox/soniox-sdk` (TypeScript types включены)

### Маппинг Soniox → Transcript Interface Contract

Целевой контракт (из architecture.md):
```typescript
{
  speakers: [{ name: string, segments: [{ start: number, end: number, text: string }] }],
  metadata: { date: string, duration: number, meeting_type: string }
}
```

Маппинг от Soniox tokens:
- Группировать tokens по `speaker` → массив speakers
- Объединять последовательные tokens одного speaker в segments (start_ms первого, end_ms последнего, конкатенация text)
- `name` = `Speaker {N}` (маппинг на реальные имена — в Story 1.2 через стейкхолдерную карту)
- `metadata.date` = дата файла, `duration` = max(end_ms) из tokens, `meeting_type` = определяется по источнику URL

### Google Drive Download

Google Meet сохраняет записи в Google Drive owner'a встречи. Варианты скачивания:
- **Share link** (public/anyone-with-link): direct download через `https://drive.google.com/uc?id={fileId}&export=download`
- **Google Drive API** (service account): `files.get` с `alt=media` — более надёжно для автоматизации
- **Формат записи Google Meet:** обычно `.webm` (VP8 video + Vorbis audio) или `.mp4`

### Критерии Go/No-Go

| Критерий | Порог | Тип |
|----------|-------|-----|
| WER на worst-case | < 15% | Критический стоп |
| Code-switching рус↔каз | Корректно на ≥ 3 записях | Критический стоп |
| Полный поток (запись → JSON) | < 5 мин для 30 мин | Важный |
| Формат Google Meet совместим | webm/mp4 принимается API | Важный |
| Webhook работает | completed + error | Важный |
| Fallback friction | < 2 мин | Обязательный |

### Важные ограничения

- **Это НЕ story реализации** — это validation story. Код тестового скрипта одноразовый, не входит в production codebase
- Тестовый скрипт `scripts/soniox-test.ts` — утилита для ручного прогона, не часть pipeline
- Результаты документируются в `docs/soniox-validation-results.md`
- Лучшие записи сохраняются для golden dataset (используются в Story 0.3 и Story 1.11)
- Soniox pricing нужно проверить в console.soniox.com — публичные данные могут быть неактуальны

### Project Structure Notes

- Тестовый скрипт: `scripts/soniox-test.ts` (вне `src/`, одноразовый)
- Документация результатов: `docs/soniox-validation-results.md`
- Golden dataset recordings: `data/golden/` (для переиспользования в Story 0.3)
- Production-код `src/adapters/transcript.ts` создаётся в Story 1.2, НЕ в этой story

### References

- [Source: _bmad-output/planning-artifacts/prd.md — Pre-MVP checklist, lines 200-204]
- [Source: _bmad-output/planning-artifacts/prd.md — Go/No-Go gates, lines 169-194]
- [Source: _bmad-output/planning-artifacts/prd.md — Soniox justification, lines 239-241]
- [Source: _bmad-output/planning-artifacts/prd.md — Stop criterion, line 191]
- [Source: _bmad-output/planning-artifacts/architecture.md — Soniox flow, line 69]
- [Source: _bmad-output/planning-artifacts/architecture.md — Transcript Interface Contract, line 285]
- [Source: _bmad-output/planning-artifacts/architecture.md — transcript.ts adapter, lines 130, 340, 537]
- [Source: _bmad-output/planning-artifacts/architecture.md — API patterns, lines 303-313]
- [Source: _bmad-output/planning-artifacts/epics.md — Story 0.1 AC, lines 373-397]
- [Source: Soniox API docs — soniox.com/docs, API v1 reference]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- npm-пакет `@soniox/soniox-node` — gRPC-клиент старого API, НЕ REST API v1. Решение: использовать REST API напрямую через fetch (Node 18+ built-in).
- Story указывает `@soniox/soniox-sdk` — такого пакета нет в npm. `@soniox/soniox-node` — gRPC only.

### Completion Notes List

- Task 1.2: Установлены typescript, tsx, @types/node. REST API используется напрямую (fetch), gRPC SDK не нужен.
- Task 1.3: Создан `scripts/soniox-test.ts` — полный скрипт валидации: upload → transcription → poll → результат → отчёт. Поддерживает одиночные файлы и директории. Автоматически генерирует `docs/soniox-validation-results.md`.

### File List

- `scripts/soniox-test.ts` — NEW — тестовый скрипт валидации Soniox API
- `tsconfig.json` — NEW — конфигурация TypeScript
- `package.json` — MODIFIED — добавлены devDependencies и npm scripts
- `.gitignore` — MODIFIED — добавлены data/ и dist/ исключения
