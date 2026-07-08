import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

// Story 7.4 (fix): одноразовый OAuth-consent для получения refresh token пользователя.
// Нужен, т.к. сервис-аккаунт не может владеть Drive-файлами (403 storage quota). После
// consent write-операции Drive/Sheets идут от имени пользователя (файлы — в его квоте).
//
// Перед запуском в .env должны быть заданы:
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
// (OAuth client типа «Desktop app» из Google Cloud Console → APIs & Services → Credentials).
//
// Запуск: npx tsx scripts/google-oauth-setup.ts
// Затем вставь напечатанный refresh_token в .env → GOOGLE_OAUTH_REFRESH_TOKEN.

const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/drive', // files.copy шаблона + permissions.create
  'https://www.googleapis.com/auth/spreadsheets', // запись данных в созданную таблицу
];

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  fail(
    'Не заданы GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET в .env.\n' +
      'Создай OAuth client типа «Desktop app» в Google Cloud Console и впиши их в .env.',
  );
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // обязателен для получения refresh_token
  prompt: 'consent', // форсируем выдачу refresh_token даже при повторном consent
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith('/oauth2callback')) {
    res.writeHead(404).end('not found');
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
  const err = new URL(req.url, REDIRECT_URI).searchParams.get('error');
  if (err) {
    res.writeHead(400).end(`OAuth error: ${err}. Вернись в терминал.`);
    // eslint-disable-next-line no-console
    console.error(`❌ OAuth отклонён: ${err}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end('нет ?code в запросе');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(
      '✅ Готово. Refresh token напечатан в терминале — вернись туда и вставь его в .env.',
    );
    // eslint-disable-next-line no-console
    console.log('\n✅ OAuth consent получен.');
    if (tokens.refresh_token) {
      // eslint-disable-next-line no-console
      console.log('\nВставь в .env:\n');
      // eslint-disable-next-line no-console
      console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } else {
      // eslint-disable-next-line no-console
      console.error(
        '⚠️ refresh_token не пришёл. Обычно это значит, что consent уже давался ранее.\n' +
          'Отзови доступ на https://myaccount.google.com/permissions и повтори, ' +
          'либо приложение уже имеет сохранённый refresh_token.',
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('❌ Обмен кода на токен не удался:', e);
    res.writeHead(500).end('token exchange failed — см. терминал');
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 100);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log('🔑 OAuth-настройка Google (одноразовая).\n');
  // eslint-disable-next-line no-console
  console.log('1) Убедись, что в OAuth client (Desktop app) разрешён redirect на loopback.');
  // eslint-disable-next-line no-console
  console.log(`2) Открой в браузере ИМЕННО под тем аккаунтом, где лежит шаблон:\n`);
  // eslint-disable-next-line no-console
  console.log(`   ${authUrl}\n`);
  // eslint-disable-next-line no-console
  console.log('3) Разреши доступ. После редиректа refresh_token появится здесь.\n');
  // eslint-disable-next-line no-console
  console.log(`(жду коллбэк на ${REDIRECT_URI} …)`);
});
