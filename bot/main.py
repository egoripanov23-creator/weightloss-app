"""Telegram-бот для AI WeightLoss Mini App + менеджер + тикеты."""

import asyncio
import base64
import json
import logging
import os
import secrets
import time
from datetime import datetime
from urllib.parse import quote, urlencode

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
import db
import aiohttp
from aiohttp import web
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import CommandStart, Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    MenuButtonWebApp,
    ReplyKeyboardMarkup,
    WebAppInfo,
    Contact,
)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
MINI_APP_URL = "https://aifoodbot.duckdns.org/"
SITE_URL = "https://aifoodbot.duckdns.org/"
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "").strip()
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "").strip()
LEONARDO_API_KEY = os.environ.get("LEONARDO_API_KEY", "").strip()
LEONARDO_API_BASE = os.environ.get("LEONARDO_API_BASE", "https://cloud.leonardo.ai/api/rest-v1").strip()
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(__file__))
os.makedirs(DATA_DIR, exist_ok=True)
TICKETS_FILE = os.path.join(DATA_DIR, "tickets.json")
REVIEWS_FILE = os.path.join(DATA_DIR, "reviews.json")
SOURCES_FILE = os.path.join(DATA_DIR, "sources.json")

# Admin IDs (manager) — ticket notifications are sent here.
ADMIN_IDS = {5781304476}  # ваш Telegram ID (менеджер тикетов)

# Temporary in-memory storage for pending registrations (token -> data)
PENDING_REGISTRATIONS = {}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("weightloss-bot")

def _load_session_key():
    b64 = os.environ.get("SESSION_PRIVATE_KEY_B64", "").strip()
    if not b64:
        return None
    try:
        pem = base64.b64decode(b64)
        return serialization.load_pem_private_key(pem, password=None)
    except Exception as e:
        logger.error(f"Session key load error: {e}")
        return None

SESSION_PRIVATE_KEY = _load_session_key()

def sign_session(login, name="", phone=""):
    if SESSION_PRIVATE_KEY is None:
        return secrets.token_urlsafe(24)
    payload = {"login": login, "name": name or login, "phone": phone, "iat": int(time.time()), "nonce": secrets.token_urlsafe(8)}
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = SESSION_PRIVATE_KEY.sign(data, padding.PKCS1v15(), hashes.SHA256())
    return (base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii") + "." +
            base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii"))

def verify_session_token(token):
    if SESSION_PRIVATE_KEY is None:
        return None
    if not token or not isinstance(token, str) or "." not in token:
        return None
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        payload = base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4))
        signature = base64.urlsafe_b64decode(sig_b64 + "=" * (-len(sig_b64) % 4))
        SESSION_PRIVATE_KEY.public_key().verify(signature, payload, padding.PKCS1v15(), hashes.SHA256())
        data = json.loads(payload.decode("utf-8"))
        if time.time() - float(data.get("iat", 0)) > 30 * 24 * 3600:
            return None
        if not data.get("login"):
            return None
        return data
    except Exception:
        return None

bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
dp = Dispatcher(storage=MemoryStorage())


# ---------- Ticket storage ----------
def load_tickets():
    try:
        with open(TICKETS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_tickets(tickets):
    with open(TICKETS_FILE, "w", encoding="utf-8") as f:
        json.dump(tickets, f, ensure_ascii=False, indent=2)


def next_ticket_id(tickets):
    return max([t.get("id", 0) for t in tickets], default=0) + 1


# ---------- Traffic source tracking ----------
def log_source(user_id, source):
    try:
        try:
            with open(SOURCES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        data[source] = data.get(source, 0) + 1
        data["_users"] = data.get("_users", 0) + 1
        with open(SOURCES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to log source: {e}")


# ---------- Review storage ----------
def load_reviews():
    try:
        with open(REVIEWS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_reviews_file(reviews):
    with open(REVIEWS_FILE, "w", encoding="utf-8") as f:
        json.dump(reviews, f, ensure_ascii=False, indent=2)


async def save_review(message, payload):
    reviews = load_reviews()
    rating = max(1, min(5, int(payload.get("rating", 5))))
    text = payload.get("text", "").strip() or "Без текста"
    reviews.append({
        "rating": rating,
        "text": text,
        "user_id": message.chat.id,
        "name": f"{message.from_user.first_name} {message.from_user.last_name or ''}".strip(),
        "username": message.from_user.username or "",
        "date": datetime.now().isoformat(),
    })
    save_reviews_file(reviews)
    await message.answer(
        f"⭐ Спасибо за отзыв ({rating}/5)!\n\n{text[:200]}\n\n"
        "Мы обязательно учтём ваше мнение 💚",
        reply_markup=app_keyboard(),
    )
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(
                admin_id,
                f"⭐ <b>Новый отзыв {rating}/5</b>\nОт: {message.from_user.first_name} (@{message.from_user.username})\n\n{text[:500]}",
            )
        except Exception as e:
            logger.error(f"Failed to notify admin about review: {e}")


TICKET_CATEGORIES = {
    "bug": "🐛 Проблема / баг",
    "question": "❓ Вопрос по диете",
    "payment": "💳 Оплата / доступ",
    "feature": "💡 Предложение",
    "other": "📝 Другое",
}

TICKET_STATUS = {
    "open": "🟡 Открыт",
    "answered": "✅ Отвечен",
    "closed": "⚪ Закрыт",
}


class TicketStates(StatesGroup):
    waiting_message = State()


class RegStates(StatesGroup):
    waiting_contact = State()


# ---------- Keyboards ----------
def app_keyboard():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Открыть приложение", web_app=WebAppInfo(url=MINI_APP_URL))],
        [InlineKeyboardButton(text="🌐 Открыть сайт", url=SITE_URL)],
    ])


def main_menu():
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🚀 Открыть Mini App")],
            [KeyboardButton(text="💬 Написать менеджеру"), KeyboardButton(text="🎫 Мои тикеты")],
            [KeyboardButton(text="🌐 Сайт")],
        ],
        resize_keyboard=True,
    )


def manager_keyboard():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✍️ Создать тикет", callback_data="ticket_new")],
        [InlineKeyboardButton(text="🎫 Мои тикеты", callback_data="ticket_list")],
        [InlineKeyboardButton(text="🚀 Открыть приложение", web_app=WebAppInfo(url=MINI_APP_URL))],
    ])


# ---------- Commands ----------
@dp.message(CommandStart())
async def cmd_start(message, state: FSMContext):
    # Registration deep-link: /start reg_<token>
    args = ""
    if message.text and len(message.text.split(maxsplit=1)) > 1:
        args = message.text.split(maxsplit=1)[1].strip()
    # Track traffic source (e.g. /start channel1)
    if args and not args.startswith(("reg_", "ticket_", "review_")):
        log_source(message.from_user.id, args)
    if args.startswith("reg_"):
        token = args[4:].strip()
        await state.update_data(reg_token=token)
        await state.set_state(RegStates.waiting_contact)
        kb = ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text="📱 Подтвердить номер", request_contact=True)]],
            resize_keyboard=True,
            one_time_keyboard=True,
        )
        await message.answer(
            "👋 Добро пожаловать в <b>AI WeightLoss</b>!\n\n"
            "Чтобы завершить регистрацию на сайте, подтвердите ваш номер телефона — "
            "нажмите кнопку ниже 👇",
            reply_markup=kb,
        )
        return

    # Ticket deep-link from Mini App: /start ticket_<base64json>
    if args.startswith("ticket_"):
        try:
            raw = args[7:]
            raw += "=" * (-len(raw) % 4)
            payload = json.loads(base64.urlsafe_b64decode(raw).decode("utf-8"))
            await create_ticket_from_payload(message, payload)
        except Exception as e:
            logger.error(f"Ticket deeplink parse error: {e}")
            await message.answer("Не удалось создать тикет из приложения. Напишите сообщение вручную — я передам менеджеру.")
            await state.set_state(TicketStates.waiting_message)
        return

    # Login deep-link: /start login_<base64json>
    if args.startswith("login_"):
        raw = args[6:] + "=" * (-len(args[6:]) % 4)
        try:
            payload = json.loads(base64.urlsafe_b64decode(raw).decode("utf-8"))
            user = db.verify_user(payload.get("login", ""), payload.get("password", ""))
            if user:
                session = sign_session(user["login"], user.get("name", "") or user["login"], user.get("phone", ""))
                qs = urlencode({"session": session, "login": user["login"], "name": user.get("name", "") or user["login"]})
                kb = InlineKeyboardMarkup(inline_keyboard=[
                    [InlineKeyboardButton(text="✅ Войти в приложение", url=f"{SITE_URL}?{qs}")],
                ])
                await message.answer(
                    f"✅ Добро пожаловать, {user['login']}!\n\nНажмите кнопку, чтобы войти в приложение.",
                    reply_markup=kb,
                )
            else:
                await message.answer("❌ Неверный логин или пароль. Попробуйте ещё раз на сайте.")
        except Exception as e:
            logger.error(f"Login deeplink error: {e}")
            await message.answer("Ошибка входа. Попробуйте ещё раз.")
        return

    # Review deep-link from Mini App: /start review_<base64json>
    if args.startswith("review_"):
        try:
            raw = args[7:]
            raw += "=" * (-len(raw) % 4)
            payload = json.loads(base64.urlsafe_b64decode(raw).decode("utf-8"))
            await save_review(message, payload)
        except Exception as e:
            logger.error(f"Review deeplink parse error: {e}")
        return

    await message.answer(
        "🥗 <b>AI WeightLoss</b>\n\n"
        "Персональный AI-помощник для похудения:\n"
        "• 📸 Рацион по вашим предпочтениям\n"
        "• ⚖️ Отслеживание веса с графиком\n"
        "• 🤖 Чат с ИИ-диетологом\n"
        "• 💚 AI-анализ и поддержка\n\n"
        "🤖 ИИ работает автоматически — ничего настраивать не нужно!\n\n"
        "Выберите действие в меню ниже 👇",
        reply_markup=main_menu(),
    )


@dp.message(Command("app"))
async def cmd_app(message):
    await message.answer("Открыть Mini App:", reply_markup=app_keyboard())


@dp.message(Command("site"))
async def cmd_site(message):
    await message.answer("🌐 Наш сайт:", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Открыть сайт", url=SITE_URL)],
    ]))


@dp.message(Command("manager"))
async def cmd_manager(message):
    await message.answer(
        "👤 <b>Менеджер поддержки</b>\n\n"
        "Есть вопрос, проблема или предложение? Создайте тикет — менеджер ответит вам здесь, в боте.\n\n"
        "Для срочной связи напишите менеджеру напрямую в Telegram.",
        reply_markup=manager_keyboard(),
    )


@dp.message(Command("tickets"))
async def cmd_tickets(message):
    await show_my_tickets(message)


@dp.message(Command("reply"))
async def cmd_reply(message):
    """Admin only: /reply <ticket_id> <text>"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Эта команда только для менеджера.")
        return
    parts = message.text.split(maxsplit=2)
    if len(parts) < 3:
        await message.answer("Использование: /reply <номер тикета> <ответ>")
        return
    try:
        tid = int(parts[1])
    except ValueError:
        await message.answer("Номер тикета должен быть числом.")
        return
    answer = parts[2]
    tickets = load_tickets()
    ticket = next((t for t in tickets if t["id"] == tid), None)
    if not ticket:
        await message.answer(f"Тикет №{tid} не найден.")
        return
    ticket["status"] = "answered"
    ticket["answer"] = answer
    ticket["answered_at"] = datetime.now().isoformat()
    if not ticket.get("user_id"):
        db_user = db.get_user(ticket.get("login", ""))
        if db_user and db_user.get("telegram_id"):
            ticket["user_id"] = db_user["telegram_id"]
    save_tickets(tickets)
    user_id = ticket.get("user_id") or 0
    if user_id:
        try:
            await bot.send_message(
                user_id,
                f"📩 <b>Ответ по тикету №{tid}</b>\n\n{answer}\n\n"
                "Если проблема осталась — создайте новый тикет.",
            )
        except Exception as e:
            logger.error(f"Failed to notify user: {e}")
    else:
        logger.info(f"Ticket {tid} has no Telegram user to notify; answer available in app")
    await message.answer(f"✅ Ответ отправлен по тикету №{tid}.")


@dp.message(Command("close"))
async def cmd_close(message):
    """Admin only: /close <ticket_id>"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Только для менеджера.")
        return
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2:
        await message.answer("Использование: /close <номер тикета>")
        return
    try:
        tid = int(parts[1])
    except ValueError:
        await message.answer("Номер тикета должен быть числом.")
        return
    tickets = load_tickets()
    ticket = next((t for t in tickets if t["id"] == tid), None)
    if not ticket:
        await message.answer(f"Тикет №{tid} не найден.")
        return
    ticket["status"] = "closed"
    ticket["closed_at"] = datetime.now().isoformat()
    if not ticket.get("user_id"):
        db_user = db.get_user(ticket.get("login", ""))
        if db_user and db_user.get("telegram_id"):
            ticket["user_id"] = db_user["telegram_id"]
    save_tickets(tickets)
    user_id = ticket.get("user_id") or 0
    if user_id:
        try:
            await bot.send_message(user_id, f"⚪ Тикет №{tid} закрыт менеджером. Спасибо за обращение!")
        except Exception as e:
            logger.error(f"Failed to notify user: {e}")
    await message.answer(f"✅ Тикет №{tid} закрыт.")


@dp.message(Command("status"))
async def cmd_status(message):
    tickets = load_tickets()
    mine = [t for t in tickets if t["user_id"] == message.chat.id]
    if not mine:
        await message.answer("У вас пока нет тикетов.")
        return
    t = mine[-1]
    await message.answer(
        f"🎫 <b>Тикет №{t['id']}</b>\n"
        f"Статус: {TICKET_STATUS.get(t['status'], t['status'])}\n"
        f"Тема: {t.get('subject','')}\n\n{t['text'][:300]}"
        + (f"\n\n💬 Ответ: {t['answer']}" if t.get("answer") else ""),
        reply_markup=manager_keyboard(),
    )


@dp.callback_query(F.data.startswith("admin_reply_"))
async def cb_admin_reply(callback):
    if callback.from_user.id not in ADMIN_IDS:
        await callback.answer("Нет прав", show_alert=True)
        return
    tid = int(callback.data.replace("admin_reply_", ""))
    await callback.message.answer(f"Введите ответ для тикета №{tid} (командой /reply {tid} ваш_ответ):")
    await callback.answer()


@dp.callback_query(F.data.startswith("admin_close_"))
async def cb_admin_close(callback):
    if callback.from_user.id not in ADMIN_IDS:
        await callback.answer("Нет прав", show_alert=True)
        return
    tid = int(callback.data.replace("admin_close_", ""))
    tickets = load_tickets()
    ticket = next((t for t in tickets if t["id"] == tid), None)
    if ticket:
        ticket["status"] = "closed"
        ticket["closed_at"] = datetime.now().isoformat()
        save_tickets(tickets)
        try:
            await bot.send_message(ticket["user_id"], f"⚪ Тикет №{tid} закрыт менеджером. Спасибо!")
        except Exception:
            pass
        await callback.answer(f"Тикет №{tid} закрыт", show_alert=True)
        await callback.message.edit_reply_markup(reply_markup=None)
    else:
        await callback.answer("Тикет не найден", show_alert=True)


@dp.message(Command("users"))
async def cmd_users(message):
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Только для менеджера.")
        return
    users = db.list_users(30)
    text = f"👥 <b>Пользователей в БД: {db.count_users()}</b>\n\n"
    if not users:
        text += "Пока нет зарегистрированных пользователей."
    for u in users:
        text += (
            f"<b>#{u['id']} {u['login']}</b>\n"
            f"📱 {u['phone']}"
            + (f" · ✉️ {u['email']}" if u.get('email') else "")
            + f"\nЗаходил: {u.get('last_login') or 'никогда'}\n\n"
        )
    await message.answer(text)


@dp.message(Command("finduser"))
async def cmd_finduser(message):
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Только для менеджера.")
        return
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2:
        await message.answer("Использование: /finduser <логин>")
        return
    u = db.get_user(parts[1])
    if not u:
        await message.answer("Пользователь не найден.")
        return
    await message.answer(
        f"<b>{u['login']}</b>\n📱 {u['phone']}\n✉️ {u.get('email') or '—'}\n"
        f"Имя: {u.get('name') or '—'}\nСоздан: {u['created_at']}\nПоследний вход: {u.get('last_login') or 'никогда'}"
    )


@dp.message(Command("stats"))
async def cmd_stats(message):
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Только для менеджера.")
        return
    try:
        with open(SOURCES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    reviews = load_reviews()
    tickets = load_tickets()
    total_users = data.get("_users", 0)
    text = (
        "📊 <b>Статистика</b>\n\n"
        f"👥 Запусков по referral-ссылкам: {total_users}\n"
        f"⭐ Отзывов: {len(reviews)}\n"
        f"🎫 Тикетов: {len(tickets)}\n\n"
        "<b>Источники переходов:</b>\n"
    )
    sources = {k: v for k, v in data.items() if not k.startswith("_")}
    if sources:
        for k, v in sorted(sources.items(), key=lambda x: -x[1]):
            text += f"• {k}: {v}\n"
    else:
        text += "• пока нет (добавьте ?start=название в ссылки)\n"
    await message.answer(text)


@dp.message(Command("reviews"))
async def cmd_reviews(message):
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Только для менеджера.")
        return
    reviews = load_reviews()
    if not reviews:
        await message.answer("Отзывов пока нет.")
        return
    avg = sum(r.get("rating", 5) for r in reviews) / len(reviews)
    text = f"⭐ <b>Отзывы: {len(reviews)}, средняя оценка {avg:.1f}/5</b>\n\n"
    for r in reviews[-20:]:
        text += f"{'⭐' * r.get('rating',5)} — {r.get('name','?')}\n{r.get('text','')[:150]}\n\n"
    await message.answer(text)


@dp.message(Command("alltickets"))
async def cmd_alltickets(message):
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("⛔ Только для менеджера.")
        return
    tickets = load_tickets()
    if not tickets:
        await message.answer("Тикетов пока нет.")
        return
    text = "<b>Все тикеты:</b>\n\n"
    for t in tickets[-20:]:
        text += (
            f"#{t['id']} [{t['status']}] {t.get('name','?')} "
            f"(@{t.get('username','-')})\n{t['text'][:100]}\n\n"
        )
    await message.answer(text)


@dp.message(Command("help"))
async def cmd_help(message):
    await message.answer(
        "📖 <b>Помощь</b>\n\n"
        "/start — начать\n"
        "/app — открыть Mini App\n"
        "/site — открыть сайт\n"
        "/manager — центр поддержки\n"
        "/ticket <текст> — создать тикет\n"
        "/tickets — мои тикеты\n"
        "/status — статус последнего тикета\n"
        "/reply <id> <текст> — ответ (менеджер)\n"
        "/close <id> — закрыть (менеджер)\n"
        "/alltickets — все тикеты (менеджер)\n"
        "/reviews — отзывы пользователей (менеджер)\n"
        "/stats — статистика и источники (менеджер)\n"
        "/users — пользователи в БД (менеджер)\n"
        "/finduser <логин> — найти пользователя (менеджер)\n"
        "/help — эта справка",
        reply_markup=main_menu(),
    )


# ---------- Callbacks ----------
@dp.callback_query(F.data == "ticket_new")
async def cb_ticket_new(callback, state: FSMContext):
    await callback.message.answer("✍️ Напишите ваш вопрос или опишите проблему — я передам менеджеру:")
    await state.set_state(TicketStates.waiting_message)
    await callback.answer()


@dp.callback_query(F.data == "ticket_list")
async def cb_ticket_list(callback):
    await show_my_tickets(callback.message)
    await callback.answer()


async def show_my_tickets(message):
    tickets = load_tickets()
    mine = [t for t in tickets if t["user_id"] == message.chat.id]
    if not mine:
        await message.answer("У вас пока нет тикетов.", reply_markup=manager_keyboard())
        return
    text = "<b>Ваши тикеты:</b>\n\n"
    for t in mine[-10:]:
        status_icon = {"open": "🟡", "answered": "✅", "closed": "⚪"}.get(t["status"], "🟡")
        text += f"{status_icon} <b>№{t['id']}</b> — {t['text'][:80]}\n"
        if t.get("answer"):
            text += f"   💬 Ответ: {t['answer'][:80]}\n"
        text += "\n"
    await message.answer(text, reply_markup=manager_keyboard())


async def create_ticket_record(login, name, text, category="other", subject=""):
    tickets = load_tickets()
    tid = next_ticket_id(tickets)
    db_user = db.get_user(login)
    telegram_id = (db_user or {}).get("telegram_id")
    ticket = {
        "id": tid,
        "user_id": telegram_id or 0,
        "login": login,
        "name": name or login,
        "username": login,
        "category": category,
        "subject": subject or text[:60],
        "text": text,
        "status": "open",
        "created_at": datetime.now().isoformat(),
    }
    tickets.append(ticket)
    save_tickets(tickets)

    cat_name = TICKET_CATEGORIES.get(category, "📝 Другое")
    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"💬 Ответить №{tid}", callback_data=f"admin_reply_{tid}")],
        [InlineKeyboardButton(text=f"⚪ Закрыть №{tid}", callback_data=f"admin_close_{tid}")],
    ])
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(
                admin_id,
                f"🎫 <b>Новый тикет №{tid}</b>\n"
                f"От: {ticket['name']} (@{ticket['username']})\n"
                f"Категория: {cat_name}\nТема: {ticket['subject']}\n\n"
                f"{text[:500]}\n\n"
                f"Ответить: /reply {tid} ваш_ответ\nЗакрыть: /close {tid}",
                reply_markup=admin_kb,
            )
        except Exception as e:
            logger.error(f"Failed to notify admin {admin_id}: {e}")
    return ticket

async def save_new_ticket(message, text, category="other", subject=""):
    """Create a ticket and notify admins with action buttons."""
    tickets = load_tickets()
    tid = next_ticket_id(tickets)
    ticket = {
        "id": tid,
        "user_id": message.chat.id,
        "name": f"{message.from_user.first_name} {message.from_user.last_name or ''}".strip(),
        "username": message.from_user.username or "",
        "category": category,
        "subject": subject or text[:60],
        "text": text,
        "status": "open",
        "created_at": datetime.now().isoformat(),
    }
    tickets.append(ticket)
    save_tickets(tickets)

    cat_name = TICKET_CATEGORIES.get(category, "📝 Другое")
    await message.answer(
        f"✅ <b>Тикет №{tid} создан</b>\n\n"
        f"Категория: {cat_name}\nТема: {ticket['subject']}\n\n"
        "Менеджер получил ваше обращение и ответит здесь.\n"
        "Проверить статус: /tickets",
        reply_markup=main_menu(),
    )

    admin_kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"💬 Ответить №{tid}", callback_data=f"admin_reply_{tid}")],
        [InlineKeyboardButton(text=f"⚪ Закрыть №{tid}", callback_data=f"admin_close_{tid}")],
    ])
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(
                admin_id,
                f"🎫 <b>Новый тикет №{tid}</b>\n"
                f"От: {ticket['name']} (@{ticket['username']})\n"
                f"Категория: {cat_name}\nТема: {ticket['subject']}\n\n"
                f"{text[:500]}\n\n"
                f"Ответить: /reply {tid} ваш_ответ\nЗакрыть: /close {tid}",
                reply_markup=admin_kb,
            )
        except Exception as e:
            logger.error(f"Failed to notify admin {admin_id}: {e}")
    return ticket


async def create_ticket_from_payload(message, payload):
    text = payload.get("text", "").strip() or "(без текста)"
    category = payload.get("category", "other")
    subject = payload.get("subject", "").strip()
    ticket = await save_new_ticket(message, text, category, subject)
    # Return link to Mini App "my tickets"
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🎫 Мои тикеты в приложении", web_app=WebAppInfo(url=MINI_APP_URL + "?tickets=1"))],
    ])
    await message.answer("Проверить статус тикета можно в приложении 👇", reply_markup=kb)


@dp.message(Command("ticket"))
async def cmd_ticket(message):
    args = message.text.split(maxsplit=1)
    if len(args) < 2:
        cats = "\n".join(f"{v}" for v in TICKET_CATEGORIES.values())
        await message.answer(
            "Создать тикет: /ticket <ваш вопрос>\n\nКатегории: " + cats
        )
        return
    await save_new_ticket(message, args[1].strip())


@dp.message(TicketStates.waiting_message)
async def ticket_message(message, state: FSMContext):
    await state.clear()
    await save_new_ticket(message, message.text or "(без текста)")


# ---------- Registration via deep-link ----------
@dp.message(RegStates.waiting_contact, F.contact)
async def reg_contact(message, state: FSMContext):
    from urllib.parse import urlencode
    contact = message.contact
    if contact.user_id != message.from_user.id:
        await message.answer("Пожалуйста, поделитесь своим номером телефона.")
        return
    data = await state.get_data()
    token = (data.get("reg_token") or "").strip()
    await state.clear()

    pending = PENDING_REGISTRATIONS.pop(token, None)
    if not pending or (time.time() - pending.get("created", 0) > 600):
        await message.answer("⚠️ Данные регистрации устарели или не найдены. Вернитесь на сайт и начните регистрацию заново.")
        return

    login = pending.get("login", "")
    password = pending.get("password", "")
    email = pending.get("email", "")
    name = f"{contact.first_name} {contact.last_name or ''}".strip() or pending.get("name", "")
    phone = contact.phone_number

    # Save to database
    ok, result = db.create_user(
        login=login, password=password, phone=phone,
        email=email, name=name, telegram_id=message.from_user.id,
    )
    if not ok:
        await message.answer(f"⚠️ {result}\n\nВернитесь на сайт и выберите другой логин.")
        return

    session = sign_session(login, name, phone)
    qs = urlencode({"reg": token, "phone": phone, "name": name, "login": login, "session": session})
    return_url = f"{SITE_URL}?{qs}"

    await bot.set_chat_menu_button(
        chat_id=message.chat.id,
        menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=MINI_APP_URL)),
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Вернуться на сайт", url=return_url)],
    ])
    await message.answer(
        f"✅ Номер подтверждён: {phone}\n\n"
        f"Имя: {name}\n\n"
        "Нажмите кнопку ниже, чтобы вернуться на сайт — данные сохранятся автоматически.",
        reply_markup=kb,
    )


# ---------- Contact / menu buttons ----------
@dp.message(F.contact)
async def handle_contact(message):
    contact = message.contact
    if contact.user_id != message.from_user.id:
        await message.answer("Пожалуйста, поделитесь своим номером телефона.")
        return
    await bot.set_chat_menu_button(
        chat_id=message.chat.id,
        menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=MINI_APP_URL)),
    )
    await message.answer(
        f"✅ Спасибо, {contact.first_name}! Номер: {contact.phone_number}\n\n"
        "Откройте приложение:",
        reply_markup=app_keyboard(),
    )


# ---------- Text menu ----------
@dp.message(F.text == "🚀 Открыть Mini App")
async def menu_app(message):
    await cmd_app(message)


@dp.message(F.text == "🌐 Сайт")
async def menu_site(message):
    await cmd_site(message)


@dp.message(F.text == "💬 Написать менеджеру")
async def menu_manager(message):
    await cmd_manager(message)


@dp.message(F.text == "🎫 Мои тикеты")
async def menu_tickets(message):
    await show_my_tickets(message)


@dp.message()
async def fallback(message):
    await message.answer(
        "Используйте меню ниже 👇",
        reply_markup=main_menu(),
    )


async def handle_generate_image(request):
    """Генерация изображения блюда через Leonardo.ai (или Pollinations как фолбэк)."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400, headers={"Access-Control-Allow-Origin": "*"})
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return web.json_response({"error": "prompt is required"}, status=400, headers={"Access-Control-Allow-Origin": "*"})

    # Leonardo.ai приоритет
    if LEONARDO_API_KEY:
        try:
            headers = {
                "Authorization": f"Bearer {LEONARDO_API_KEY}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
            body = {
                "prompt": prompt,
                "modelId": "b60a243c-7c7d-4a8e-9d1c-8e5c6e2a1b3f",  # Leonardo Phoenix
                "width": 1024,
                "height": 768,
                "num_images": 1,
                "guidance_scale": 7,
                "num_inference_steps": 20,
            }
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{LEONARDO_API_BASE}/generations", headers=headers, json=body, timeout=60) as resp:
                    if resp.status == 200:
                        result = await resp.json()
                        gens = result.get("generations", [])
                        if gens and gens[0].get("url"):
                            return web.json_response({"url": gens[0]["url"], "provider": "leonardo"}, headers={"Access-Control-Allow-Origin": "*"})
                    else:
                        txt = await resp.text()
                        logger.error(f"Leonardo error {resp.status}: {txt}")
        except Exception as e:
            logger.error(f"Leonardo generation error: {e}")

    # Фолбэк на Pollinations (бесплатно, без ключа)
    try:
        from urllib.parse import urlencode as _urlencode
        poll_prompt = prompt + ", modern food photography, high detail, studio lighting, appetizing"
        poll_url = "https://image.pollinations.ai/prompt/" + quote(poll_prompt) + "?width=768&height=512&model=flux&nologo=true&private=true&safe=true&enhance=true&seed=0"
        return web.json_response({"url": poll_url, "provider": "pollinations"}, headers={"Access-Control-Allow-Origin": "*"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500, headers={"Access-Control-Allow-Origin": "*"})

async def handle_health(request):
    return web.json_response({"status": "ok"}, headers={"Access-Control-Allow-Origin": "*"})

async def handle_pending_registration(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400, headers={"Access-Control-Allow-Origin": "*"})
    token = (data.get("token") or "").strip()
    login = (data.get("login") or "").strip()
    password = data.get("password") or ""
    email = (data.get("email") or "").strip()
    name = (data.get("name") or "").strip()
    if not token or len(token) > 64 or not login or not password:
        return web.json_response({"error": "token, login and password are required"}, status=400, headers={"Access-Control-Allow-Origin": "*"})
    PENDING_REGISTRATIONS[token] = {"login": login, "password": password, "email": email, "name": name, "created": time.time()}
    # cleanup old
    now = time.time()
    for k in [k for k, v in PENDING_REGISTRATIONS.items() if now - v.get("created", 0) > 600]:
        PENDING_REGISTRATIONS.pop(k, None)
    return web.json_response({"ok": True}, headers={"Access-Control-Allow-Origin": "*"})

async def handle_login(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400, headers={"Access-Control-Allow-Origin": "*"})
    login = (data.get("login") or "").strip()
    password = data.get("password") or ""
    user = db.verify_user(login, password)
    if not user:
        return web.json_response({"error": "invalid credentials"}, status=401, headers={"Access-Control-Allow-Origin": "*"})
    session = sign_session(user["login"], user.get("name", "") or user["login"], user.get("phone", ""))
    return web.json_response({
        "session": session,
        "user": {"login": user["login"], "name": user.get("name") or user["login"], "phone": user.get("phone", ""), "email": user.get("email", "")},
    }, headers={"Access-Control-Allow-Origin": "*"})

async def handle_create_ticket(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400, headers={"Access-Control-Allow-Origin": "*"})
    session_data = verify_session_token(data.get("session"))
    if not session_data:
        return web.json_response({"error": "unauthorized"}, status=401, headers={"Access-Control-Allow-Origin": "*"})
    text = (data.get("text") or data.get("subject") or "").strip()
    if not text:
        return web.json_response({"error": "text is required"}, status=400, headers={"Access-Control-Allow-Origin": "*"})
    category = (data.get("category") or "other").strip()
    subject = (data.get("subject") or text[:60]).strip()
    ticket = await create_ticket_record(session_data["login"], session_data.get("name") or session_data["login"], text, category, subject)
    return web.json_response({"ok": True, "ticket": ticket}, headers={"Access-Control-Allow-Origin": "*"})

async def handle_list_tickets(request):
    session = request.query.get("session") or ""
    session_data = verify_session_token(session)
    if not session_data:
        return web.json_response({"error": "unauthorized"}, status=401, headers={"Access-Control-Allow-Origin": "*"})
    tickets = [t for t in load_tickets() if t.get("login") == session_data["login"]]
    return web.json_response({"tickets": tickets}, headers={"Access-Control-Allow-Origin": "*"})

async def handle_telegram_webhook(request):
    if WEBHOOK_SECRET and request.headers.get("X-Telegram-Bot-Api-Secret-Token") != WEBHOOK_SECRET:
        return web.Response(status=403, text="forbidden")
    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="bad json")
    try:
        await dp.feed_webhook_update(bot, data, secret_token=WEBHOOK_SECRET or None)
    except Exception as e:
        logger.error(f"Webhook feed error: {e}")
        return web.Response(status=500, text="error")
    return web.Response(text="ok")

async def start_api():
    app = web.Application()
    app.router.add_get("/api/health", handle_health)
    app.router.add_post("/api/auth/register/pending", handle_pending_registration)
    app.router.add_post("/api/auth/login", handle_login)
    app.router.add_post("/api/tickets/create", handle_create_ticket)
    app.router.add_get("/api/tickets", handle_list_tickets)
    app.router.add_post("/api/generate-image", handle_generate_image)
    if WEBHOOK_URL:
        app.router.add_post("/webhook", handle_telegram_webhook)
    app.router.add_options("/api/auth/register/pending", lambda r: web.Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }))
    app.router.add_options("/api/auth/login", lambda r: web.Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }))
    app.router.add_options("/api/tickets/create", lambda r: web.Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8000)
    await site.start()
    logger.info("API running on port 8000")

async def main():
    await start_api()
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=MINI_APP_URL)),
    )
    if WEBHOOK_URL:
        await bot.set_webhook(WEBHOOK_URL, secret_token=WEBHOOK_SECRET or None)
        logger.info("Webhook set: %s", WEBHOOK_URL)
        await asyncio.Event().wait()
    else:
        logger.info("Бот запущен")
        await dp.start_polling(bot)


if __name__ == "__main__":
    # Auto-restart loop: if polling crashes (network error, Telegram hiccup),
    # wait a few seconds and reconnect instead of dying.
    async def run_forever():
        while True:
            try:
                await main()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Bot crashed: {e}. Restarting in 5s...")
                await asyncio.sleep(5)
    asyncio.run(run_forever())
