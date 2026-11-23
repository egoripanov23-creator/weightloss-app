# 🌐 Как сделать бота доступным 24/7 (даже при выключенном ПК)

Сайт уже работает постоянно (GitHub Pages). Чтобы **бот** тоже работал всегда, его нужно запустить на сервере (VPS). Ниже — готовый комплект и пошаговая инструкция.

## Что уже подготовлено в репозитории
- `bot/Dockerfile` — образ с Python и зависимостями
- `bot/docker-compose.yml` — автозапуск + автоперезапуск при сбое (`restart: always`)
- `bot/backup_data.py` — перенос базы пользователей и тикетов
- `bot/main.py` — автоматический reconnect при обрыве связи с Telegram

## Шаг 1 — Получить VPS (один раз)
Бесплатные/дешёвые варианты:
- **Oracle Cloud Free Tier** — навсегда бесплатный ARM-сервер (самый выгодный)
- **Vultr / Hetzner / Timeweb** — от ~$3–5/мес
- Выберите Ubuntu 22.04/24.04, откройте порт 22 (SSH)

## Шаг 2 — Скопировать проект на сервер
На вашем ПК (PowerShell):
```powershell
# Сначала сохранить базу и тикеты
python bot\backup_data.py

# Затем загрузить проект (замените IP на ваш)
scp -r weightloss-app root@ВАШ_IP:~/
```
На сервере:
```bash
cd ~/weightloss-app/bot
unzip -o ../bot_data_backup.zip -d data/   # перенести пользователей и тикеты
```

## Шаг 3 — Создать .env на сервере
```bash
cd ~/weightloss-app/bot
cat > .env << 'EOF'
BOT_TOKEN=9041043385:AAFlvPugr1OCclUhqG7mztpjytl7h3I_9F4
AI_API_KEY=ваш_ключ_kakistore
EOF
```
⚠️ Токен выше — тот же самый. Если он мог утечь в публичном репо ранее — лучше сначала сделать новый у @BotFather (`/token` → Revoke).

## Шаг 4 — Запустить
```bash
cd ~/weightloss-app/bot
docker compose up -d --build
```
Проверить:
```bash
docker compose logs -f          # должно быть "Бот запущен"
docker compose ps               # статус Up
```

## Шаг 5 — Проверить
1. Напишите боту https://t.me/foodAi1_bot → должен ответить
2. Проверьте `/users` — все старые пользователи на месте (база перенесена)

## Обновление кода в будущем
```bash
cd ~/weightloss-app
git pull
cd bot && docker compose up -d --build
```

## Альтернатива — systemd без Docker
Если Docker не хотите:
```bash
sudo nano /etc/systemd/system/weightloss-bot.service
```
```
[Unit]
Description=AI WeightLoss Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/weightloss-app/bot
Environment="DATA_DIR=/root/weightloss-app/bot/data"
ExecStart=/usr/bin/python3 main.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now weightloss-bot
sudo systemctl status weightloss-bot
```

## Итог
| Компонент | Где работает | Когда ПК выключен |
|-----------|--------------|-------------------|
| Сайт / Mini App | GitHub Pages (облако) | ✅ работает |
| Бот (подтверждение номера, тикеты, вход) | VPS | ✅ работает после деплоя |
| База пользователей | `data/users.db` на VPS | ✅ сохраняется |
