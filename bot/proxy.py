"""HTTP-прокси для AI-запросов (обход CORS). Запускается alongside ботом."""

import asyncio
import logging
from aiohttp import web, ClientSession

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("proxy")

AI_BASE_URL = "https://api.baza-ai.org/v1"
AI_API_KEY = "REDACTED_AI_KEY"
AI_MODEL = "gpt-6.1-terra"


async def handle_ai(request):
    """Проксирует AI-запросы от Mini App."""
    try:
        data = await request.json()
        messages = data.get("messages", [])
        temperature = data.get("temperature", 0.7)
        max_tokens = data.get("max_tokens", 2000)

        async with ClientSession() as session:
            async with session.post(
                f"{AI_BASE_URL}/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {AI_API_KEY}",
                },
                json={
                    "model": AI_MODEL,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                timeout=60,
            ) as resp:
                result = await resp.json()
                return web.json_response(result, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                })
    except Exception as e:
        logger.error(f"Proxy error: {e}")
        return web.json_response({"error": str(e)}, status=500, headers={
            "Access-Control-Allow-Origin": "*",
        })


async def handle_health(request):
    return web.json_response({"status": "ok"}, headers={
        "Access-Control-Allow-Origin": "*",
    })


async def start_proxy(port=8080):
    app = web.Application()
    app.router.add_post("/ai", handle_ai)
    app.router.add_get("/health", handle_health)
    app.router.add_options("/ai", lambda r: web.Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info(f"Proxy running on port {port}")
    return runner


if __name__ == "__main__":
    loop = asyncio.get_event_loop()
    loop.run_until_complete(start_proxy())
    try:
        loop.run_forever()
    except KeyboardInterrupt:
        pass