# Деплой на Vercel

Краткая инструкция по выкладке проекта на Vercel с базой Neon (PostgreSQL).

## 1. База данных (Neon)

1. Зайдите на [neon.tech](https://neon.tech) и создайте проект.
2. В настройках проекта скопируйте:
   - **Connection string** с опцией **Pooled connection** → это будет `DATABASE_URL`
   - **Connection string** с опцией **Direct connection** → это будет `DIRECT_URL`

## 2. Миграции (один раз перед первым деплоем)

Локально выполните миграции, подставив продакшен-строку Neon:

```bash
# В .env установите DATABASE_URL и DIRECT_URL от Neon (продакшен)
npm run db:migrate
```

Затем создайте админ-пользователя:

```bash
npm run db:seed
```

Логин и пароль — из переменных `ADMIN_SEED_EMAIL` и `ADMIN_SEED_PASSWORD` в `.env`.

## 3. Проект на Vercel

1. Зайдите на [vercel.com](https://vercel.com), привяжите репозиторий (GitHub/GitLab/Bitbucket).
2. Выберите репозиторий с этим проектом. Framework Preset: **Next.js** (определится автоматически).
3. **Environment Variables** — добавьте переменные для Production (и при необходимости для Preview):

| Переменная | Описание | Обязательно |
|------------|----------|-------------|
| `DATABASE_URL` | Строка подключения Neon (Pooled) | Да |
| `DIRECT_URL` | Строка подключения Neon (Direct) | Да |
| `JWT_SECRET` | Секрет для JWT (минимум 32 символа) | Да |
| `ADMIN_SEED_EMAIL` | Email админа (для сида и входа) | Да |
| `ADMIN_SEED_PASSWORD` | Пароль админа | Да |
| `SESSION_TIMEOUT_MINUTES` | Таймаут сессии в минутах (по умолчанию 30) | Нет |

4. Нажмите **Deploy**.

## 4. После деплоя

- Откройте `https://<ваш-проект>.vercel.app`.
- Вход: **Login** → используйте `ADMIN_SEED_EMAIL` и `ADMIN_SEED_PASSWORD`.

## Важно

- **Миграции** на Vercel не запускаются автоматически. Их нужно выполнять локально с продакшен-`DATABASE_URL`/`DIRECT_URL` или в CI перед деплоем.
- **Seed** тоже выполняется один раз локально (или из CI) с продакшен-подключением.
- На Vercel при сборке автоматически выполняется `prisma generate` (скрипт `postinstall` в `package.json`).

## Проверка сборки локально

Перед пушем можно проверить продакшен-сборку:

```bash
npm run build
```

Если сборка проходит — на Vercel деплой должен пройти успешно (при корректных переменных окружения).
