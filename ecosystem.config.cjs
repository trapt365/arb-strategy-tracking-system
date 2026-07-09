// pm2-конфиг нативного прод-запуска (без Docker). Запуск:
//   pm2 start ecosystem.config.cjs && pm2 save
// NODE_ENV задаём здесь: dotenv НЕ перетирает уже установленные process.env,
// поэтому config.ts увидит production (JSON-логи вместо pino-pretty).
// .cjs — т.к. в package.json "type":"module", а pm2-конфиг должен быть CommonJS.
module.exports = {
  apps: [
    {
      name: 'tracking-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      // WSL-маршрут до api.telegram.org коннектится ~0.5–1 с, а дефолтный
      // Happy-Eyeballs-таймаут node (autoSelectFamily) — 250 мс: node убивал живую
      // IPv4-попытку, падал на мёртвый в WSL IPv6 и получал ETIMEDOUT, пока
      // curl с того же хоста работал. Симптом: бот online, health ok, но 0 TCP
      // и молчание на команды (2026-07-09). 3 с хватает с запасом.
      node_args: '--network-family-autoselection-attempt-timeout=3000',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Almaty',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // Long-polling бот — один инстанс (иначе Telegram 409 Conflict).
      instances: 1,
      exec_mode: 'fork',
      error_file: 'data/pm2/err.log',
      out_file: 'data/pm2/out.log',
      time: true,
    },
  ],
};
