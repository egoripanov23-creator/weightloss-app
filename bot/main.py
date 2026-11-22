"""Telegram-бот для AI WeightLoss Mini App + менеджер + тикеты."""

import asyncio
import json
import logging
import os
from datetime import datetime

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

BOT_TOKEN = "REDACTED_BOT_TOKEN"
MINI_APP_URL = "https://egoripanov23-creator.github.io/weightloss-app/"
SITE_URL = "https://egoripanov23-creator.github.io/weightloss-app/"
TICKETS_FILE = os.path.join(os.path.dirname(__file__), "tickets.json")

# Admin IDs (manager). Add your Telegram ID here to receive/reply tickets.
ADMIN_IDS = {123456789}  # <-- replace with your Telegram ID

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("weightloss-bot")

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
    if args.startswith("reg_"):
        token = args[4:]
        await state.update_data(reg_token=token)
        await state.set_state(RegStates.waiting_contact)
        kb = ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text="📱 Подтвердить номер", request_contact=True)]],
            resize_keyboard=True,
            one_time_keyboard=True,
        )
        await message.answer(
            "👋 Добро пожаловать в <b>AI WeightLoss</b>!\n\n"
            "Чтобы продолжить регистрацию на сайте, подтвердите ваш номер телефона — "
            "нажмите кнопку ниже 👇",
            reply_markup=kb,
        )
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
    save_tickets(tickets)
    try:
        await bot.send_message(
            ticket["user_id"],
            f"📩 <b>Ответ по тикету №{tid}</b>\n\n{answer}\n\n"
            "Если проблема осталась — создайте новый тикет.",
        )
    except Exception as e:
        logger.error(f"Failed to notify user: {e}")
    await message.answer(f"✅ Ответ отправлен по тикету №{tid}.")


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
        "/manager — связаться с менеджером\n"
        "/tickets — мои тикеты\n"
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


@dp.message(TicketStates.waiting_message)
async def ticket_message(message, state: FSMContext):
    tickets = load_tickets()
    tid = next_ticket_id(tickets)
    ticket = {
        "id": tid,
        "user_id": message.chat.id,
        "name": f"{message.from_user.first_name} {message.from_user.last_name or ''}".strip(),
        "username": message.from_user.username or "",
        "text": message.text or "(без текста)",
        "status": "open",
        "created_at": datetime.now().isoformat(),
    }
    tickets.append(ticket)
    save_tickets(tickets)
    await state.clear()
    await message.answer(
        f"✅ <b>Тикет №{tid} создан</b>\n\nМенеджер получил ваше обращение и ответит здесь.\n"
        "Проверить статус: /tickets",
        reply_markup=main_menu(),
    )
    # Notify admins
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(
                admin_id,
                f"🎫 <b>Новый тикет №{tid}</b>\nОт: {ticket['name']} (@{ticket['username']})\n\n{ticket['text'][:400]}\n\n"
                f"Ответить: /reply {tid} ваш_ответ",
            )
        except Exception as e:
            logger.error(f"Failed to notify admin {admin_id}: {e}")


# ---------- Registration via deep-link ----------
@dp.message(RegStates.waiting_contact, F.contact)
async def reg_contact(message, state: FSMContext):
    from urllib.parse import urlencode
    contact = message.contact
    if contact.user_id != message.from_user.id:
        await message.answer("Пожалуйста, поделитесь своим номером телефона.")
        return
    data = await state.get_data()
    token = data.get("reg_token", "")
    await state.clear()

    phone = contact.phone_number
    name = f"{contact.first_name} {contact.last_name or ''}".strip()
    qs = urlencode({"reg": token, "phone": phone, "name": name})
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


async def main():
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=MINI_APP_URL)),
    )
    logger.info("Бот запущен")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
