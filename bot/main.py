"""Telegram-бот для AI WeightLoss Mini App."""

import asyncio
import logging

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import CommandStart
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("weightloss-bot")

bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
dp = Dispatcher()


@dp.message(CommandStart())
async def start(message):
    # Request phone number
    keyboard = ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="📱 Поделиться номером", request_contact=True)],
        ],
        resize_keyboard=True,
        one_time_keyboard=True,
    )
    await message.answer(
        "🥗 <b>AI WeightLoss</b>\n\n"
        "Персональный AI-помощник для похудения:\n"
        "• 📸 Составление рациона по вашим предпочтениям\n"
        "• ⚖️ Отслеживание веса с графиком\n"
        "• 💚 AI-поддержка и мотивация\n"
        "• 🎯 Персональные цели и планы\n\n"
        "🤖 ИИ работает автоматически — ключ и регистрация не нужны!\n\n"
        "Для начала работы поделитесь номером телефона:",
        reply_markup=keyboard,
    )


@dp.message(F.contact)
async def handle_contact(message):
    contact = message.contact
    if contact.user_id != message.from_user.id:
        await message.answer("Пожалуйста, поделитесь своим номером телефона.")
        return

    phone = contact.phone_number
    name = f"{contact.first_name} {contact.last_name or ''}".strip()

    # Save user data
    import json
    user_data = {
        "telegram_id": message.from_user.id,
        "name": name,
        "phone": phone,
        "username": message.from_user.username,
    }

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="🚀 Открыть приложение",
            web_app=WebAppInfo(url=MINI_APP_URL),
        )],
    ])

    await message.answer(
        f"✅ Спасибо, {contact.first_name}!\n\n"
        f"Ваш номер: {phone}\n\n"
        "Откройте приложение для составления рациона:",
        reply_markup=keyboard,
    )

    # Set menu button
    await bot.set_chat_menu_button(
        chat_id=message.chat.id,
        menu_button=MenuButtonWebApp(
            text="Открыть",
            web_app=WebAppInfo(url=MINI_APP_URL),
        ),
    )


@dp.message()
async def fallback(message):
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="🚀 Открыть приложение",
            web_app=WebAppInfo(url=MINI_APP_URL),
        )],
    ])
    await message.answer(
        "Используйте приложение для составления рациона и отслеживания веса:",
        reply_markup=keyboard,
    )


async def main():
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(
            text="Открыть",
            web_app=WebAppInfo(url=MINI_APP_URL),
        )
    )
    logger.info("Бот запущен")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
