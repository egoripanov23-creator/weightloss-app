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
    MenuButtonWebApp,
    WebAppInfo,
)

BOT_TOKEN = "REDACTED_BOT_TOKEN"
MINI_APP_URL = "https://egoripanov23-creator.github.io/weightloss-app/"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("weightloss-bot")

bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
dp = Dispatcher()


@dp.message(CommandStart())
async def start(message):
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="🚀 Открыть приложение",
            web_app=WebAppInfo(url=MINI_APP_URL),
        )],
    ])
    await message.answer(
        "🥗 <b>AI WeightLoss</b>\n\n"
        "Персональный AI-помощник для похудения:\n"
        "• 📸 Составление рациона по вашим предпочтениям\n"
        "• ⚖️ Отслеживание веса с графиком\n"
        "• 💚 AI-поддержка и мотивация\n"
        "• 🎯 Персональные цели и планы\n\n"
        "Нажмите кнопку ниже, чтобы начать:",
        reply_markup=keyboard,
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
