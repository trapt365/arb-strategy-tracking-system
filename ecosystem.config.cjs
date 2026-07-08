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
