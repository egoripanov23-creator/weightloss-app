// ============================================================
// AI WeightLoss Mini App — Main Application
// ============================================================

// ---------- Configuration ----------
// Multiple FREE keyless AI providers with automatic failover.
// If one is down / rate-limited / out of tokens → instantly switch to the next.
// Last working provider is remembered in localStorage and tried first next time.
const AI_ENDPOINTS = [
  { id: "keysai", url: "https://api.keysaiapifree.com/v1/chat/completions", model: "free-ai", key: "free" },
  { id: "aikey", url: "https://api.aikeyfreeapi.com/v1/chat/completions", model: "free-ai", key: "free" },
  { id: "freeapillm", url: "https://api.freeapillmkey.com/v1/chat/completions", model: "free-ai", key: "free" },
  { id: "kilo", url: "https://ai-gateway.kilo.ai/api/v1/chat/completions", model: "kilo-auto/free", key: "anonymous" },
  { id: "pollinations", url: "https://text.pollinations.ai/openai", model: "gpt-oss-20b", key: "" },
  { id: "ovh", url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", model: "qwen3.6-27b", key: "" },
];
const AI_TIMEOUT_MS = 20000; // generous — detailed recipes need more generation time

// Suppress unhandled promise rejections from Telegram SDK
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason && (e.reason.message?.includes("WebAppMethodUnsupported") || 
      e.reason.message?.includes("CloudStorage") ||
      e.reason.toString?.().includes("WebAppMethodUnsupported"))) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// Override CloudStorage to prevent errors in non-Telegram environments
if (window.Telegram?.WebApp?.CloudStorage) {
  const origGetItem = window.Telegram.WebApp.CloudStorage.getItem;
  const origSetItem = window.Telegram.WebApp.CloudStorage.setItem;
  window.Telegram.WebApp.CloudStorage.getItem = function(key, cb) {
    try { cb(new Error("not supported"), null); } catch(e) {}
  };
  window.Telegram.WebApp.CloudStorage.setItem = function(key, val, cb) {
    try { if (cb) cb(new Error("not supported")); } catch(e) {}
  };
}

// ---------- Telegram WebApp ----------
const tg = window.Telegram?.WebApp;
// Real Telegram has version >= 6.1 and initData; plain browser has version "6.0"
const tgSupports = (method) => {
  if (!tg || !isRealTelegram) return false;
  try {
    const v = String(tg.version || "0.0").split(".").map(Number);
    const major = v[0] || 0, minor = v[1] || 0;
    if (method === "setHeaderColor" || method === "setBackgroundColor") return major > 6 || (major === 6 && minor >= 1);
    if (method === "BackButton") return major > 6 || (major === 6 && minor >= 7);
    if (method === "HapticFeedback") return major > 6 || (major === 6 && minor >= 7);
    return true;
  } catch (e) { return false; }
};
const isRealTelegram = !!(tg && tg.initData && tg.initData.length > 0);

if (tg) {
  try { tg.ready(); } catch (e) {}
  try { tg.expand(); } catch (e) {}
  if (tgSupports("setHeaderColor")) { try { tg.setHeaderColor("#0a0f0d"); } catch (e) {} }
  if (tgSupports("setBackgroundColor")) { try { tg.setBackgroundColor("#0a0f0d"); } catch (e) {} }
}

// ---------- State ----------
const state = {
  screen: "agreement",
  user: null,
  settings: null,
  mealPlan: null,
  weightHistory: [],
  usedMeals: [],      // names of all dishes ever generated — never repeat
  generationCount: 0,
  chatMessages: [],
  aiMessages: [],
  isLoading: false,
};

// ---------- Navigation links ----------
const TELEGRAM_URL = "https://t.me/foodAi1_bot";
const SITE_URL = "https://aifoodbot.duckdns.org/";

// ---------- Telegram Cloud Storage helpers ----------
// Check if running inside actual Telegram (not browser)
const isTelegram = !!(tg && tg.initData && tg.initData.length > 0);

function cloudGet(key) {
  return new Promise((resolve) => {
    if (!isTelegram || !tg?.CloudStorage?.getItem) {
      resolve(null);
      return;
    }
    try {
      tg.CloudStorage.getItem(key, (err, value) => {
        if (err) { resolve(null); return; }
        try { resolve(JSON.parse(value)); } catch { resolve(value); }
      });
    } catch (e) {
      console.warn("CloudStorage getItem not available:", e);
      resolve(null);
    }
  });
}

function cloudSet(key, value) {
  return new Promise((resolve) => {
    if (!isTelegram || !tg?.CloudStorage?.setItem) {
      resolve(false);
      return;
    }
    try {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      tg.CloudStorage.setItem(key, str, (err) => {
        resolve(!err);
      });
    } catch (e) {
      console.warn("CloudStorage setItem not available:", e);
      resolve(false);
    }
  });
}

// ---------- LocalStorage helpers (for website) ----------
function localGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function localSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// ---------- Storage abstraction ----------
async function storageGet(key) {
  if (isTelegram) {
    try {
      const cloud = await cloudGet(key);
      if (cloud !== null) return cloud;
    } catch (e) {
      console.warn("storageGet cloud error:", e);
    }
  }
  return localGet(key);
}

async function storageSet(key, value) {
  if (isTelegram) {
    try {
      const cloudOk = await cloudSet(key, value);
      if (cloudOk) return;
    } catch (e) {
      console.warn("storageSet cloud error:", e);
    }
  }
  localSet(key, value);
}

// ---------- AI API ----------
// Smart automatic failover across ALL free providers.
// - Last working provider is tried first.
// - Provider that returns 429/quota is put on a short "cooldown" (skipped this round).
// - Each provider gets 2 attempts; on repeated failure we move on automatically.
// - If a cooldown provider is needed again, it is retried after a short pause.
const AI_COOLDOWN_MS = 30000; // 30s pause for rate-limited providers

async function aiChat(messages, temperature = 0.7) {
  const lastId = localStorage.getItem("ai_provider_ok") || "";
  const now = Date.now();
  // Parse cooldowns: { id: timestamp-until }
  let cooldowns = {};
  try { cooldowns = JSON.parse(localStorage.getItem("ai_cooldowns") || "{}"); } catch (e) {}

  // Order: last-working first (even if cooling, we retry it), then the rest
  const ordered = [
    ...AI_ENDPOINTS.filter(e => e.id === lastId),
    ...AI_ENDPOINTS.filter(e => e.id !== lastId),
  ];

  for (const ep of ordered) {
    // Skip providers in cooldown (except last-working, which we always retry)
    const cooling = cooldowns[ep.id] && cooldowns[ep.id] > now;
    if (cooling && ep.id !== lastId) {
      console.warn(`AI ${ep.id}: cooldown, skipping`);
      continue;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      try {
        const headers = { "Content-Type": "application/json" };
        if (ep.key) headers["Authorization"] = `Bearer ${ep.key}`;

        const res = await fetch(ep.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: ep.model,
            messages: messages,
            temperature: temperature,
            max_tokens: 2000,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json();
          const content =
            data.choices?.[0]?.message?.content ||
            data.choices?.[0]?.text ||
            data.response ||
            data.candidates?.[0]?.content?.parts?.[0]?.text ||
            "";
          if (content) {
            localStorage.setItem("ai_provider_ok", ep.id); // remember working
            delete cooldowns[ep.id]; // clear cooldown on success
            localStorage.setItem("ai_cooldowns", JSON.stringify(cooldowns));
            state.lastApiError = null;
            return content;
          }
          state.lastApiError = `${ep.id}: пустой ответ`;
        } else {
          const txt = await res.text().catch(() => "");
          state.lastApiError = `${ep.id}: HTTP ${res.status}`;
          console.warn(`AI ${ep.id} -> ${res.status}: ${txt.substring(0, 80)}`);
          // Rate limit / quota / overload → put on cooldown, move to next provider
          if (res.status === 429 || res.status === 402 || res.status === 503) {
            cooldowns[ep.id] = Date.now() + AI_COOLDOWN_MS;
            localStorage.setItem("ai_cooldowns", JSON.stringify(cooldowns));
            break; // stop retrying this provider
          }
        }
      } catch (err) {
        clearTimeout(timeout);
        state.lastApiError = err?.name === "AbortError" ? `${ep.id}: таймаут` : `${ep.id}: ${err?.message || "сеть"}`;
        console.warn(`AI ${ep.id} error:`, err?.message);
      }
      // small pause before retrying same provider
      if (attempt === 0) await new Promise(r => setTimeout(r, 400));
    }
  }
  return null;
}

// Normalize AI output: force Russian meal types + correct weight format
function normalizeMealPlan(data) {
  if (!data || !Array.isArray(data.meals)) return data;
  const typeMap = {
    "breakfast": "Завтрак", "завтрак": "Завтрак",
    "snack": "Перекус", "перекус": "Перекус", "перекусы": "Перекус",
    "lunch": "Обед", "обед": "Обед",
    "dinner": "Ужин", "ужин": "Ужин", "supper": "Ужин",
  };
  data.meals = data.meals.map(m => {
    const key = String(m.type || "").toLowerCase().trim();
    return {
      ...m,
      type: typeMap[key] || m.type || "Приём пищи",
      weight: typeof m.weight === "number" ? `${m.weight} г` : (m.weight || "portionen"),
    };
  });
  return data;
}

// ---------- Data ----------
const PRODUCTS = [
  // === Мясо и птица ===
  { id: "chicken", name: "Курица", icon: "🍗", desc: "Белое мясо" },
  { id: "turkey", name: "Индейка", icon: "🦃", desc: "Диетическое мясо" },
  { id: "beef", name: "Говядина", icon: "🥩", desc: "Красное мясо" },
  { id: "pork", name: "Свинина", icon: "🥓", desc: "Постная" },
  { id: "lamb", name: "Баранина", icon: "🍖", desc: "Мясо" },
  { id: "rabbit", name: "Кролик", icon: "🐰", desc: "Диетическое" },
  { id: "duck", name: "Утка", icon: "🦆", desc: "Мясо" },
  { id: "sausage", name: "Колбаса", icon: "🌭", desc: "Варёная" },
  { id: "ham", name: "Ветчина", icon: "🥓", desc: "Постная" },
  { id: "bacon", name: "Бекон", icon: "🥓", desc: "Копчёный" },
  // === Рыба и морепродукты ===
  { id: "fish", name: "Рыба", icon: "🐟", desc: "Лосось, треска" },
  { id: "salmon", name: "Лосось", icon: "🐟", desc: "Красная рыба" },
  { id: "tuna", name: "Тунец", icon: "🐟", desc: "Консервированный" },
  { id: "cod", name: "Треска", icon: "🐟", desc: "Белая рыба" },
  { id: "shrimp", name: "Креветки", icon: "🦐", desc: "Морепродукты" },
  { id: "squid", name: "Кальмар", icon: "🦑", desc: "Морепродукты" },
  { id: "mussels", name: "Мидии", icon: "🐚", desc: "Моллюски" },
  { id: "crab", name: "Краб", icon: "🦀", desc: "Морепродукты" },
  { id: "caviar", name: "Икра", icon: "🥚", desc: "Красная/чёрная" },
  // === Яйца ===
  { id: "eggs", name: "Яйца куриные", icon: "🥚", desc: "Куриные" },
  { id: "quail_eggs", name: "Яйца перепелиные", icon: "🥚", desc: "Перепелиные" },
  // === Молочные продукты ===
  { id: "dairy", name: "Молочные", icon: "🥛", desc: "Творог, кефир" },
  { id: "milk", name: "Молоко", icon: "🥛", desc: "Коровье" },
  { id: "kefir", name: "Кефир", icon: "🥛", desc: "Кисломолочный" },
  { id: "yogurt", name: "Йогурт", icon: "🥛", desc: "Натуральный" },
  { id: "cottage_cheese", name: "Творог", icon: "🥛", desc: "Обезжиренный" },
  { id: "cheese", name: "Сыр", icon: "🧀", desc: "Твёрдый" },
  { id: "feta", name: "Фета", icon: "🧀", desc: "Брынза" },
  { id: "mozzarella", name: "Моцарелла", icon: "🧀", desc: "Мягкий сыр" },
  { id: "sour_cream", name: "Сметана", icon: "🥛", desc: "10-20%" },
  { id: "butter", name: "Масло сливочное", icon: "🧈", desc: "Сливочное" },
  // === Крупы и злаки ===
  { id: "rice", name: "Рис", icon: "🍚", desc: "Белый/бурый" },
  { id: "buckwheat", name: "Гречка", icon: "🌾", desc: "Каша" },
  { id: "oats", name: "Овсянка", icon: "🌾", desc: "Каши" },
  { id: "quinoa", name: "Киноа", icon: "🌾", desc: "Суперфуд" },
  { id: "bulgur", name: "Булгур", icon: "🌾", desc: "Крупа" },
  { id: "couscous", name: "Кускус", icon: "🌾", desc: "Крупа" },
  { id: "millet", name: "Пшено", icon: "🌾", desc: "Каша" },
  { id: "barley", name: "Перловка", icon: "🌾", desc: "Крупа" },
  { id: "corn", name: "Кукуруза", icon: "🌽", desc: "Крупа/овощ" },
  { id: "pasta", name: "Паста", icon: "🍝", desc: "Макароны" },
  { id: "noodles", name: "Лапша", icon: "🍜", desc: "Рисовая/гречневая" },
  // === Овощи ===
  { id: "vegetables", name: "Овощи", icon: "🥦", desc: "Свежие" },
  { id: "tomato", name: "Помидор", icon: "🍅", desc: "Свежий" },
  { id: "cucumber", name: "Огурец", icon: "🥒", desc: "Свежий" },
  { id: "pepper", name: "Перец", icon: "🌶️", desc: "Болгарский" },
  { id: "carrot", name: "Морковь", icon: "🥕", desc: "Свежая" },
  { id: "broccoli", name: "Брокколи", icon: "🥦", desc: "Свежая" },
  { id: "cauliflower", name: "Цветная капуста", icon: "🥦", desc: "Свежая" },
  { id: "spinach", name: "Шпинат", icon: "🥬", desc: "Зелень" },
  { id: "lettuce", name: "Салат", icon: "🥬", desc: "Листовой" },
  { id: "cabbage", name: "Капуста", icon: "🥬", desc: "Белокочанная" },
  { id: "zucchini", name: "Кабачок", icon: "🥒", desc: "Свежий" },
  { id: "eggplant", name: "Баклажан", icon: "🍆", desc: "Свежий" },
  { id: "onion", name: "Лук", icon: "🧅", desc: "Репчатый" },
  { id: "garlic", name: "Чеснок", icon: "🧄", desc: "Свежий" },
  { id: "potato", name: "Картофель", icon: "🥔", desc: "Отварной" },
  { id: "sweet_potato", name: "Батат", icon: "🍠", desc: "Сладкий картофель" },
  { id: "beetroot", name: "Свёкла", icon: "🟣", desc: "Свежая" },
  { id: "radish", name: "Редис", icon: "🔴", desc: "Свежий" },
  { id: "asparagus", name: "Спаржа", icon: "🌿", desc: "Свежая" },
  { id: "artichoke", name: "Артишок", icon: "🌿", desc: "Свежий" },
  { id: "celery", name: "Сельдерей", icon: "🌿", desc: "Стебли" },
  { id: "pumpkin", name: "Тыква", icon: "🎃", desc: "Свежая" },
  { id: "mushrooms", name: "Грибы", icon: "🍄", desc: "Шампиньоны" },
  // === Фрукты и ягоды ===
  { id: "fruits", name: "Фрукты", icon: "🍎", desc: "Сезонные" },
  { id: "apple", name: "Яблоко", icon: "🍎", desc: "Свежее" },
  { id: "banana", name: "Банан", icon: "🍌", desc: "Свежий" },
  { id: "orange", name: "Апельсин", icon: "🍊", desc: "Цитрус" },
  { id: "lemon", name: "Лимон", icon: "🍋", desc: "Цитрус" },
  { id: "grape", name: "Виноград", icon: "🍇", desc: "Свежий" },
  { id: "strawberry", name: "Клубника", icon: "🍓", desc: "Ягода" },
  { id: "blueberry", name: "Черника", icon: "🫐", desc: "Ягода" },
  { id: "raspberry", name: "Малина", icon: "🍓", desc: "Ягода" },
  { id: "watermelon", name: "Арбуз", icon: "🍉", desc: "Свежий" },
  { id: "melon", name: "Дыня", icon: "🍈", desc: "Свежая" },
  { id: "peach", name: "Персик", icon: "🍑", desc: "Свежий" },
  { id: "pear", name: "Груша", icon: "🍐", desc: "Свежая" },
  { id: "kiwi", name: "Киви", icon: "🥝", desc: "Свежий" },
  { id: "mango", name: "Манго", icon: "🥭", desc: "Тропический" },
  { id: "pineapple", name: "Ананас", icon: "🍍", desc: "Тропический" },
  { id: "avocado", name: "Авокадо", icon: "🥑", desc: "Здоровые жиры" },
  { id: "pomegranate", name: "Гранат", icon: "🍎", desc: "Свежий" },
  { id: "cherries", name: "Вишня", icon: "🍒", desc: "Ягода" },
  // === Орехи и семена ===
  { id: "nuts", name: "Орехи", icon: "🥜", desc: "Миндаль, грецкие" },
  { id: "almonds", name: "Миндаль", icon: "🥜", desc: "Орех" },
  { id: "walnuts", name: "Грецкие орехи", icon: "🥜", desc: "Орех" },
  { id: "cashews", name: "Кешью", icon: "🥜", desc: "Орех" },
  { id: "peanuts", name: "Арахис", icon: "🥜", desc: "Орех" },
  { id: "pistachios", name: "Фисташки", icon: "🥜", desc: "Орех" },
  { id: "seeds", name: "Семена", icon: "🌻", desc: "Подсолнечник, лён" },
  { id: "chia", name: "Чиа", icon: "🌱", desc: "Семена" },
  { id: "flax", name: "Льняное семя", icon: "🌱", desc: "Семена" },
  // === Масла и жиры ===
  { id: "olive_oil", name: "Оливковое масло", icon: "🫒", desc: "Extra virgin" },
  { id: "coconut_oil", name: "Кокосовое масло", icon: "🥥", desc: "Рафинированное" },
  { id: "butter", name: "Масло сливочное", icon: "🧈", desc: "Сливочное" },
  // === Бобовые ===
  { id: "tofu", name: "Тофу", icon: "🧊", desc: "Растительный белок" },
  { id: "lentils", name: "Чечевица", icon: "🫘", desc: "Бобовые" },
  { id: "beans", name: "Фасоль", icon: "🫘", desc: "Красная/белая" },
  { id: "chickpeas", name: "Нут", icon: "🫘", desc: "Бобовые" },
  { id: "peas", name: "Горох", icon: "🫛", desc: "Зелёный" },
  // === Хлеб и выпечка ===
  { id: "bread", name: "Хлеб", icon: "🍞", desc: "Цельнозерновой" },
  { id: "whole_wheat_bread", name: "Цельнозерновой хлеб", icon: "🍞", desc: "Хлеб" },
  { id: "rye_bread", name: "Ржаной хлеб", icon: "🍞", desc: "Хлеб" },
  { id: "pita", name: "Пита", icon: "🫓", desc: "Лепёшка" },
  { id: "tortilla", name: "Тортилья", icon: "🌮", desc: "Лепёшка" },
  // === Сладости и десерты ===
  { id: "honey", name: "Мёд", icon: "🍯", desc: "Натуральный" },
  { id: "dark_chocolate", name: "Тёмный шоколад", icon: "🍫", desc: "70%+ какао" },
  { id: "dried_fruits", name: "Сухофрукты", icon: "🍇", desc: "Изюм, курага" },
  { id: "granola", name: "Гранола", icon: "🥣", desc: "Хрустящая" },
  { id: "protein_bar", name: "Протеиновый батончик", icon: "🍫", desc: "Спортивный" },
  // === Напитки ===
  { id: "water", name: "Вода", icon: "💧", desc: "Питьевая" },
  { id: "green_tea", name: "Зелёный чай", icon: "🍵", desc: "Без сахара" },
  { id: "coffee", name: "Кофе", icon: "☕", desc: "Чёрный" },
  { id: "smoothie", name: "Смузи", icon: "🥤", desc: "Фруктовый" },
  // === Специи и приправы ===
  { id: "salt", name: "Соль", icon: "🧂", desc: "Морская" },
  { id: "pepper_spice", name: "Перец чёрный", icon: "🌶️", desc: "Молотый" },
  { id: "cinnamon", name: "Корица", icon: "🫚", desc: "Молотая" },
  { id: "ginger", name: "Имбирь", icon: "🫚", desc: "Свежий" },
  { id: "turmeric", name: "Куркума", icon: "🟡", desc: "Молотая" },
  { id: "basil", name: "Базилик", icon: "🌿", desc: "Свежий" },
  { id: "parsley", name: "Петрушка", icon: "🌿", desc: "Зелень" },
  { id: "dill", name: "Укроп", icon: "🌿", desc: "Зелень" },
  // === Готовые продукты ===
  { id: "soup", name: "Суп", icon: "🍲", desc: "Овощной/куриный" },
  { id: "salad", name: "Салат", icon: "🥗", desc: "Овощной" },
  { id: "omelette", name: "Омлет", icon: "🍳", desc: "Яичный" },
  { id: "porridge", name: "Каша", icon: "🥣", desc: "Молочная" },
  { id: "yogurt_drink", name: "Йогурт питьевой", icon: "🥛", desc: "Напиток" },
  { id: "protein_shake", name: "Протеиновый коктейль", icon: "🥤", desc: "Спортивный" },
];

const ALLERGIES = [
  { id: "gluten", name: "Глютен", icon: "🌾" },
  { id: "lactose", name: "Лактоза", icon: "🥛" },
  { id: "nuts", name: "Орехи", icon: "🥜" },
  { id: "seafood", name: "Морепродукты", icon: "🦐" },
  { id: "eggs", name: "Яйца", icon: "🥚" },
  { id: "soy", name: "Соя", icon: "🫘" },
];

const DIFFICULTY = [
  { id: "easy", name: "Лёгкая", icon: "😊", desc: "Простые блюда, минимум готовки" },
  { id: "medium", name: "Средняя", icon: "🤔", desc: "Разнообразное меню" },
  { id: "hard", name: "Сложная", icon: "💪", desc: "Строгая диета, точный подсчёт" },
];

// ---------- Screen Navigation ----------
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.classList.add("exit");
  });
  const target = document.getElementById(`screen-${name}`);
  target.classList.remove("exit");
  target.classList.add("active");
  state.screen = name;
  // Hide floating review badge on onboarding screens so it never blocks buttons
  const reviewBadge = document.getElementById("review-btn");
  if (reviewBadge) reviewBadge.classList.toggle("hidden", ["agreement", "registration"].includes(name));
  try { if (tgSupports("BackButton") && tg?.BackButton) tg.BackButton.isVisible = (name !== "agreement" && name !== "mealplan"); } catch (e) {}
  
  // Haptic feedback
  try { if (tgSupports("HapticFeedback") && tg?.HapticFeedback) tg.HapticFeedback.impactOccurred("light"); } catch (e) {}
}

// ---------- Three.js Background ----------
function initThree() {
  const canvas = document.getElementById("bg-canvas");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Particles
  const particlesGeometry = new THREE.BufferGeometry();
  const count = 80;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const accent = new THREE.Color(0x9be15d);
  const accent2 = new THREE.Color(0x4ade80);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 20;
    const c = Math.random() > 0.5 ? accent : accent2;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  particlesGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  particlesGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const particlesMaterial = new THREE.PointsMaterial({
    size: 0.15,
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
  });

  const particles = new THREE.Points(particlesGeometry, particlesMaterial);
  scene.add(particles);

  // Floating spheres
  const spheres = [];
  for (let i = 0; i < 5; i++) {
    const geo = new THREE.SphereGeometry(0.3 + Math.random() * 0.4, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? 0x9be15d : 0x4ade80,
      transparent: true,
      opacity: 0.15,
      wireframe: true,
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 8
    );
    scene.add(sphere);
    spheres.push(sphere);
  }

  camera.position.z = 8;

  let mouseX = 0, mouseY = 0;
  document.addEventListener("mousemove", (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  function animate() {
    requestAnimationFrame(animate);
    particles.rotation.x += 0.0003;
    particles.rotation.y += 0.0005;
    spheres.forEach((s, i) => {
      s.rotation.x += 0.002 + i * 0.001;
      s.rotation.y += 0.003 + i * 0.001;
      s.position.y += Math.sin(Date.now() * 0.001 + i) * 0.001;
    });
    camera.position.x += (mouseX * 0.5 - camera.position.x) * 0.02;
    camera.position.y += (-mouseY * 0.5 - camera.position.y) * 0.02;
    camera.lookAt(scene.position);
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ---------- Render Screens ----------
function renderAgreement() {
  const el = document.getElementById("screen-agreement");
  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 3rem; margin-bottom: 12px;">🥗</div>
        <h1>AI <span class="grad">WeightLoss</span></h1>
        <p>Персональный AI-помощник для похудения</p>
      </div>
      <div class="agreement-content">
        <h3>Пользовательское соглашение</h3>
        <p>Добро пожаловать в AI WeightLoss! Используя это приложение, вы соглашаетесь со следующими условиями:</p>
        <h3>1. Общие положения</h3>
        <p>Приложение предоставляет рекомендации по питанию на основе данных, введённых пользователем. Все рекомендации носят информационный характер.</p>
        <h3>2. Медицинский дисклеймер</h3>
        <p>Приложение не является медицинским продуктом и не заменяет консультацию врача или диетолога. Перед началом любой диеты проконсультируйтесь со специалистом.</p>
        <h3>3. Конфиденциальность</h3>
        <p>Ваши данные (вес, рост, возраст, предпочтения) хранятся локально на вашем устройстве и в Telegram Cloud Storage. Мы не передаём данные третьим лицам.</p>
        <h3>4. Ответственность</h3>
        <p>Разработчики не несут ответственности за результаты применения рекомендаций. Результаты зависят от индивидуальных особенностей организма.</p>
        <h3>5. AI-рекомендации</h3>
        <p>Рекомендации генерируются искусственным интеллектом и носят приблизительный характер. Калорийность и БЖУ рассчитываются на основе стандартных таблиц состава продуктов.</p>
      </div>
      <div id="social-proof"></div>
      <label class="agreement-checkbox">
        <input type="checkbox" id="agree-checkbox">
        <span>Я принимаю условия пользовательского соглашения</span>
      </label>
      <button class="btn btn-primary btn-block" id="btn-agree" disabled>Продолжить</button>
    </div>
  `;
  renderSocialProof();

  const checkbox = document.getElementById("agree-checkbox");
  const btn = document.getElementById("btn-agree");
  checkbox.addEventListener("change", () => {
    btn.disabled = !checkbox.checked;
  });
  btn.addEventListener("click", () => {
    storageSet("agreed", true);
    renderRegistration();
    showScreen("registration");
  });
}

function renderRegistration() {
  const el = document.getElementById("screen-registration");
  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 2.5rem; margin-bottom: 12px;">👋</div>
        <h1>Добро пожаловать!</h1>
        <p>Расскажите о себе, чтобы мы составили персональный план</p>
      </div>
      <div class="form-group">
        <label class="form-label">Ваше имя *</label>
        <input type="text" class="form-input" id="reg-name" placeholder="Как вас зовут?" value="${state.user?.name || (tg?.initDataUnsafe?.user?.first_name || "")}">
      </div>
      <div class="form-group">
        <label class="form-label">Телефон *</label>
        <input type="tel" class="form-input" id="reg-phone" placeholder="+7 999 123-45-67" value="${state.user?.phone || ""}">
        <p style="font-size: 0.75rem; color: var(--muted); margin-top: 6px;">Подтвердите номер через Telegram — это обязательно</p>
        <button class="btn btn-ghost btn-block" id="btn-verify-telegram" style="margin-top: 8px;">📱 Подтвердить через Telegram</button>
      </div>
      <div class="form-group">
        <label class="form-label">Email (необязательно)</label>
        <input type="email" class="form-input" id="reg-email" placeholder="your@email.com" value="${state.user?.email || ""}">
      </div>
      <button class="btn btn-primary btn-block" id="btn-register">Продолжить к настройкам</button>
    </div>
  `;
  
  // Verify phone via Telegram bot (website) or directly (inside Mini App)
  const verifyBtn = document.getElementById("btn-verify-telegram");
  if (verifyBtn) {
    verifyBtn.addEventListener("click", () => {
      // Inside Telegram Mini App — use native requestContact directly
      if (tg && isTelegram && tg.requestContact) {
        try {
          tg.requestContact((contact) => {
            if (contact) {
              document.getElementById("reg-phone").value = contact.phone_number;
              if (!document.getElementById("reg-name").value) {
                document.getElementById("reg-name").value = contact.first_name + " " + (contact.last_name || "");
              }
            }
          });
        } catch (e) { console.warn("requestContact:", e); }
        return;
      }
      // On website — go to bot with registration token
      const name = document.getElementById("reg-name").value.trim();
      const token = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem("reg_token", token);
      if (name) localStorage.setItem("reg_name", name);
      const botLink = `https://t.me/foodAi1_bot?start=reg_${token}`;
      if (tg) tg.openLink(botLink); else window.open(botLink, "_blank");
    });
  }

  document.getElementById("btn-register").addEventListener("click", async () => {
    const name = document.getElementById("reg-name").value.trim();
    const phone = document.getElementById("reg-phone").value.trim();
    const email = document.getElementById("reg-email").value.trim();

    if (!name) {
      if (tg) tg.showAlert("Введите ваше имя");
      else alert("Введите ваше имя");
      return;
    }
    if (!phone || phone.replace(/[^0-9]/g, "").length < 10) {
      if (tg) tg.showAlert("Сначала подтвердите номер через Telegram");
      else alert("Сначала подтвердите номер через Telegram");
      return;
    }
    // On website, phone confirmation via Telegram bot is mandatory
    if (!isTelegram && !state.user?.verifiedViaTelegram) {
      const msg = "Сначала нажмите «Подтвердить через Telegram» и подтвердите номер в личке бота";
      if (tg) tg.showAlert(msg); else alert(msg);
      return;
    }

    state.user = { name, phone, email, verifiedViaTelegram: state.user?.verifiedViaTelegram || isTelegram, createdAt: state.user?.createdAt || new Date().toISOString() };
    await storageSet("user", state.user);
    renderSettings();
    showScreen("settings");
  });
}

function renderSettings() {
  const el = document.getElementById("screen-settings");
  const s = state.settings || {};
  const selectedProducts = s.products || [];
  const selectedAllergies = s.allergies || [];
  const difficulty = s.difficulty || "medium";

  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 2.5rem; margin-bottom: 12px;">⚙️</div>
        <h1>Настройки</h1>
        <p>Заполните данные для персонального плана</p>
      </div>

      <div class="form-group">
        <label class="form-label">Текущий вес (кг)</label>
        <input type="number" class="form-input" id="set-weight" placeholder="70" value="${s.weight || ""}" min="30" max="300">
      </div>

      <div class="form-group">
        <label class="form-label">Рост (см)</label>
        <input type="number" class="form-input" id="set-height" placeholder="170" value="${s.height || ""}" min="100" max="250">
      </div>

      <div class="form-group">
        <label class="form-label">Возраст</label>
        <input type="number" class="form-input" id="set-age" placeholder="25" value="${s.age || ""}" min="14" max="100">
      </div>

      <div class="form-group">
        <label class="form-label">Желаемый вес (кг)</label>
        <input type="number" class="form-input" id="set-target" placeholder="60" value="${s.targetWeight || ""}" min="30" max="300">
      </div>

      <div class="form-group">
        <label class="form-label">Срок (недель)</label>
        <input type="number" class="form-input" id="set-weeks" placeholder="12" value="${s.weeks || ""}" min="1" max="52">
      </div>

      <div class="form-group">
        <label class="form-label">Физическая нагрузка</label>
        <div class="difficulty-options" id="activity-grid">
          ${[
            {id:"low", name:"Низкая", icon:"🛋️"},
            {id:"medium", name:"Средняя", icon:"🚶"},
            {id:"high", name:"Высокая", icon:"🏋️"},
          ].map(a => `
            <div class="difficulty-option ${(s.activity||"low") === a.id ? "selected" : ""}" data-activity="${a.id}">
              <span class="difficulty-option__icon">${a.icon}</span>
              ${a.name}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Количество приёмов пищи</label>
        <div class="difficulty-options" id="mealscount-grid">
          ${[3,4,5,6].map(n => `
            <div class="difficulty-option ${(s.mealsCount||5) === n ? "selected" : ""}" data-mealscount="${n}">
              ${n}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Перекусы</label>
        <div class="difficulty-options" id="snacks-grid">
          <div class="difficulty-option ${(s.snacks !== false) ? "selected" : ""}" data-snacks="yes">
            <span class="difficulty-option__icon">✅</span> Да
          </div>
          <div class="difficulty-option ${(s.snacks === false) ? "selected" : ""}" data-snacks="no">
            <span class="difficulty-option__icon">❌</span> Нет
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Любимые продукты</label>
        <div class="widget-grid" id="products-grid">
          ${PRODUCTS.map(p => `
            <div class="widget ${selectedProducts.includes(p.id) ? "selected" : ""}" data-product="${p.id}">
              <span class="widget__icon">${p.icon}</span>
              <div class="widget__name">${p.name}</div>
              <div class="widget__desc">${p.desc}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Аллергии</label>
        <div class="allergy-tags" id="allergies-grid">
          ${ALLERGIES.map(a => `
            <div class="allergy-tag ${selectedAllergies.includes(a.id) ? "selected" : ""}" data-allergy="${a.id}">
              ${a.icon} ${a.name}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Сложность диеты</label>
        <div class="difficulty-options" id="difficulty-grid">
          ${DIFFICULTY.map(d => `
            <div class="difficulty-option ${difficulty === d.id ? "selected" : ""}" data-difficulty="${d.id}">
              <span class="difficulty-option__icon">${d.icon}</span>
              ${d.name}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="referral-card">
        <div class="referral-card__title">🎁 Пригласи друга — получи бонус</div>
        <p style="font-size:0.75rem; color:var(--muted); margin:6px 0;">Поделись своей ссылкой: каждый новый пользователь — +1 к вашему счёту</p>
        <div class="referral-card__code" id="ref-code">${getRefCode()}</div>
        <button class="btn btn-ghost btn-block btn-sm" id="btn-share-ref" style="margin-top:8px;">📤 Поделиться ссылкой</button>
      </div>

      <p style="text-align: center; font-size: 0.75rem; color: var(--muted); margin: 16px 0 8px;">
        🤖 ИИ работает автоматически — ключ не нужен
      </p>

      <button class="btn btn-primary btn-block" id="btn-save-start">💾 Сохранить и начать</button>
    </div>
  `;

  // Share referral link
  const shareRef = document.getElementById("btn-share-ref");
  if (shareRef) shareRef.addEventListener("click", () => {
    const link = `${SITE_URL}?ref=${getRefCode()}`;
    if (navigator.share) {
      navigator.share({ title: "AI WeightLoss", text: "Попробуй AI-диетолога — персональный рацион бесплатно!", url: link }).catch(() => {});
    } else if (tg) {
      tg.openLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Попробуй AI-диетолога — персональный рацион бесплатно!")}`);
    } else {
      navigator.clipboard?.writeText(link);
      if (tg) tg.showAlert("Ссылка скопирована!"); else alert("Ссылка скопирована: " + link);
    }
  });

  // Event listeners
  document.querySelectorAll("#products-grid .widget").forEach(w => {
    w.addEventListener("click", () => w.classList.toggle("selected"));
  });
  document.querySelectorAll("#allergies-grid .allergy-tag").forEach(t => {
    t.addEventListener("click", () => t.classList.toggle("selected"));
  });
  document.querySelectorAll("#difficulty-grid .difficulty-option").forEach(d => {
    d.addEventListener("click", () => {
      document.querySelectorAll("#difficulty-grid .difficulty-option").forEach(x => x.classList.remove("selected"));
      d.classList.add("selected");
    });
  });
  ["activity-grid", "mealscount-grid", "snacks-grid"].forEach(id => {
    document.querySelectorAll(`#${id} .difficulty-option`).forEach(opt => {
      opt.addEventListener("click", () => {
        document.querySelectorAll(`#${id} .difficulty-option`).forEach(x => x.classList.remove("selected"));
        opt.classList.add("selected");
      });
    });
  });

  document.getElementById("btn-save-start").addEventListener("click", async () => {
    const weight = parseFloat(document.getElementById("set-weight").value);
    const height = parseFloat(document.getElementById("set-height").value);
    const age = parseInt(document.getElementById("set-age").value);
    const targetWeight = parseFloat(document.getElementById("set-target").value);
    const weeks = parseInt(document.getElementById("set-weeks").value);

    if (!weight || !height || !age || !targetWeight || !weeks) {
      if (tg) tg.showAlert("Заполните все поля");
      else alert("Заполните все поля");
      return;
    }

    const products = [...document.querySelectorAll("#products-grid .widget.selected")].map(w => w.dataset.product);
    const allergies = [...document.querySelectorAll("#allergies-grid .allergy-tag.selected")].map(t => t.dataset.allergy);
    const diff = document.querySelector("#difficulty-grid .difficulty-option.selected")?.dataset.difficulty || "medium";
    const activity = document.querySelector("#activity-grid .difficulty-option.selected")?.dataset.activity || "low";
    const mealsCount = parseInt(document.querySelector("#mealscount-grid .difficulty-option.selected")?.dataset.mealscount || "5");
    const snacks = document.querySelector("#snacks-grid .difficulty-option.selected")?.dataset.snacks !== "no";

    state.settings = {
      weight, height, age, targetWeight, weeks, products, allergies, difficulty: diff,
      activity, mealsCount, snacks,
      createdAt: new Date().toISOString(),
    };
    await storageSet("settings", state.settings);
    
    // Save initial weight
    state.weightHistory = [{ date: new Date().toISOString().split("T")[0], weight }];
    await storageSet("weightHistory", state.weightHistory);

    renderMealPlan();
    showScreen("mealplan");
    generateMealPlan();
  });
}

// ---------- Meal Plan ----------
function normalizeDishName(name) {
  return String(name || "").toLowerCase().replace(/[^a-zа-яё0-9]/gi, "").trim();
}

function countRepeats(plan) {
  if (!plan?.meals) return 0;
  const used = state.usedMeals.map(normalizeDishName);
  const names = plan.meals.map(m => normalizeDishName(m.name));
  const oldRepeats = names.filter(n => used.includes(n)).length;
  // also reject duplicates inside the same day
  const internalDupes = names.length - new Set(names).size;
  return oldRepeats + internalDupes;
}

async function requestPlan(prompt, temperature) {
  const response = await aiChat([{ role: "user", content: prompt }], temperature);
  if (!response) throw new Error("Не удалось получить ответ ИИ");
  let jsonStr = response.trim().replace(/```json?\n?/gi, "").replace(/```/g, "").trim();
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1);
  const data = normalizeMealPlan(JSON.parse(jsonStr));
  if (!data.meals || data.meals.length === 0) throw new Error("Пустой план");
  return data;
}

async function generateMealPlan() {
  const s = state.settings;
  const products = s.products.map(id => PRODUCTS.find(p => p.id === id)?.name).filter(Boolean);
  const allergies = s.allergies.map(id => ALLERGIES.find(a => a.id === id)?.name).filter(Boolean);
  const diff = DIFFICULTY.find(d => d.id === s.difficulty);
  const activityNames = { low: "низкая (сидячая работа)", medium: "средняя (прогулки, лёгкие тренировки)", high: "высокая (спорт, физическая работа)" };
  const activityText = activityNames[s.activity] || "низкая";
  const mealsCount = s.mealsCount || 5;
  const snacksText = s.snacks === false ? "БЕЗ перекусов" : "с перекусами";

  state.generationCount += 1;
  await storageSet("generationCount", state.generationCount);

  const exclude = state.usedMeals.slice(-60);
  const excludeText = exclude.length
    ? `\n❌ КАТЕГОРИЧЕСКИ НЕ ПОВТОРЯЙ эти блюда (уже были раньше): ${exclude.join("; ")}. Придумай полностью новые названия и другие способы приготовления.`
    : "";
  // Variety: each new plan simply uses ordinary food combinations different from before
  // (the exclude list already handles non-repetition — no fancy "themes" needed)

  let data = null;
  let lastErr = null;
  // Up to 3 attempts — keep asking until we get a plan with zero repeats
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    const extraBan = state._lastRejected?.length
      ? `\n🚫 Особенно НЕ используй: ${state._lastRejected.join("; ")}.` : "";
    const prompt = `Ты диетолог. Составь НОВЫЙ план питания на 1 день (вариант №${state.generationCount}). Отвечай ТОЛЬКО валидным JSON, без текста до и после.

Данные: вес ${s.weight}кг, рост ${s.height}см, возраст ${s.age}, цель ${s.targetWeight}кг за ${s.weeks}нед. Продукты: ${products.join(", ") || "любые"}. Аллергии: ${allergies.join(", ") || "нет"}. Сложность: ${diff?.name || "средняя"}. Физ. нагрузка: ${activityText}. Количество приёмов пищи: ${mealsCount}. ${snacksText}.${excludeText}${extraBan}

ГЛАВНОЕ ПРАВИЛО — ПРОСТАЯ ОБЫДЕННАЯ ЕДА:
- Блюда должны быть ПРОСТЫМИ и РЕАЛЬНЫМИ, как домашний обед: "гречка с куриной грудкой и помидорами", "овсянка с яблоком", "макароны с сыром", "картофель с рыбой", "творог с бананом", "салат из огурцов и помидоров", "яйца с хлебом", "рис с курицей".
- НЕ выдумывай сложные ресторанные блюда, муссы, паштеты, рулеты, заправки, глазури, фарши, «авторские» названия. Никаких «индейковый мусс с цитрусовой ноткой»!
- Название = просто перечисление продуктов через «с»/«и». Никаких красивых формализмов.
- Ингредиенты — только обычные продукты из магазина (крупа, мясо, рыба, яйца, овощи, фрукты, молочные, хлеб, масло). Соль/перец — ок.
- Приготовление — 2-4 ПРОСТЫХ шага: «отварить», «нарезать», «обжарить», «смешать», «запечь». Никаких сложных техник.

ПРАВИЛА:
- Составь РОВНО ${mealsCount} приёмов пищи${s.snacks === false ? " (БЕЗ перекусов — только завтрак, обед, ужин и т.д.)" : ""}
- type — ТОЛЬКО русские слова: "Завтрак", "Перекус", "Обед", "Перекус", "Ужин" (НЕ breakfast/lunch/dinner!)
- Учитывай физ. нагрузку: чем выше нагрузка, тем больше калорий и белка (при низкой — меньше)
- Названия блюд должны НЕ повторять список запрещённых (но могут быть похожими по сути — главное другое название)
- weight — строка вида "200 г"
- recipe — КРАТКИЙ простой рецепт:
  "⏱ Время: X мин\n🧺 Ингредиенты: ...\n👨‍🍳 Приготовление:\n1. Отварить ...\n2. Нарезать ...\n3. Смешать ..."
  Без выдуманных соусов и сложных шагов.
- Дефицит ~500 ккал от нормы

Формат (только JSON):
{"meals":[{"type":"Завтрак","name":"Гречка с куриной грудкой и помидорами","weight":"300 г","calories":450,"protein":35,"fat":10,"carbs":45,"recipe":"⏱ Время: 20 мин\\n🧺 Ингредиенты: гречка 60г, куриная грудка 150г, помидоры 100г, масло 5г\\n👨‍🍳 Приготовление:\\n1. Отварить гречку\\n2. Обжарить нарезанную курицу\\n3. Нарезать помидоры и смешать все"}],"total":{"calories":1500,"protein":100,"fat":50,"carbs":150},"tip":"Совет на русском"}`;

    try {
      const candidate = await requestPlan(prompt, 0.9 + attempt * 0.05);
      const repeats = countRepeats(candidate);
      if (repeats === 0) {
        data = candidate;
        state._lastRejected = [];
      } else {
        state._lastRejected = candidate.meals.map(m => m.name);
        console.warn(`План имеет ${repeats} повторов — генерирую заново (попытка ${attempt + 1})`);
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (!data) {
    // AI unavailable → auto-use detailed demo plan so user always gets a result
    console.warn("AI unavailable, using demo plan:", lastErr?.message);
    data = getDemoMealPlan();
    data._demo = true;
    // remember demo dishes too so they don't repeat
    state.usedMeals = [...state.usedMeals, ...data.meals.map(m => m.name)].slice(-120);
    await storageSet("usedMeals", state.usedMeals);
  }

  // Remember every dish so it never appears again
  state.usedMeals = [...state.usedMeals, ...data.meals.map(m => m.name)].slice(-120);
  await storageSet("usedMeals", state.usedMeals);

  state.mealPlan = data;
  await storageSet("mealPlan", data);
  await storageSet("lastPlanDate", new Date().toISOString().split("T")[0]);
  renderMealPlan();
}

function renderMealPlan() {
  const el = document.getElementById("screen-mealplan");
  const plan = state.mealPlan;
  const s = state.settings;

  if (!plan) {
    renderMealPlanLoading();
    return;
  }

  const mealIcons = { "Завтрак": "🌅", "Перекус": "🍎", "Обед": "🍽️", "Ужин": "🌙" };

  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="font-size: 2.5rem; margin-bottom: 8px;">🍽️</div>
        <h1>План на <span class="grad">сегодня</span></h1>
        <p>Персональный рацион от ИИ</p>
      </div>

      <div class="meal-total">
        <div class="meal-total__value">${plan.total?.calories || 0}</div>
        <div class="meal-total__label">ккал за день</div>
        <div class="meal-card__macros" style="justify-content: center; margin-top: 12px;">
          <span>Б ${plan.total?.protein || 0}г</span>
          <span>Ж ${plan.total?.fat || 0}г</span>
          <span>У ${plan.total?.carbs || 0}г</span>
        </div>
      </div>

      ${plan.meals?.map((m, idx) => `
        <div class="meal-card" style="animation-delay: ${idx * 0.1}s;">
          <div class="meal-card__header">
            <div class="meal-card__title">${mealIcons[m.type] || "🍴"} ${m.type}</div>
            <div class="meal-card__calories">${m.calories} ккал</div>
          </div>
          <div class="meal-card__item">
            <span class="meal-card__item-name">${m.name}</span>
            <span>${m.weight}</span>
          </div>
          <div class="meal-card__macros">
            <span>Б ${m.protein}г</span>
            <span>Ж ${m.fat}г</span>
            <span>У ${m.carbs}г</span>
          </div>
          ${m.recipe ? `
            <details class="meal-card__recipe">
              <summary>📖 Подробный рецепт приготовления</summary>
              <div class="recipe-detail">${m.recipe}</div>
            </details>
          ` : ""}
        </div>
      `).join("") || ""}

      ${plan.tip ? `<div class="ai-message"><span class="ai-message__icon">💡</span>${plan.tip}</div>` : ""}

      <div style="display: flex; gap: 12px; margin-top: 20px;">
        <button class="btn btn-ghost btn-block" id="btn-regenerate">🔄 Составить ещё раз</button>
      </div>
      <button class="btn btn-primary btn-block" id="btn-open-chat" style="margin-top: 12px;">💬 Спросить ИИ о рационе</button>
      <div class="cross-links">
        ${isTelegram
          ? `<button class="btn btn-ghost" id="btn-goto-site">🌐 Открыть сайт</button>`
          : `<button class="btn btn-ghost" id="btn-goto-telegram">📱 Перейти в Telegram</button>`}
      </div>
    </div>
  `;

  document.getElementById("btn-regenerate").addEventListener("click", () => {
    generateMealPlan();
  });
  document.getElementById("btn-open-chat").addEventListener("click", () => {
    renderChat(); showScreen("chat");
  });
  const gotoSite = document.getElementById("btn-goto-site");
  if (gotoSite) gotoSite.addEventListener("click", () => {
    if (tg) tg.openLink(SITE_URL); else window.open(SITE_URL, "_blank");
  });
  const gotoTelegram = document.getElementById("btn-goto-telegram");
  if (gotoTelegram) gotoTelegram.addEventListener("click", () => {
    if (tg) tg.openLink(TELEGRAM_URL); else window.open(TELEGRAM_URL, "_blank");
  });
}

function renderMealPlanLoading() {
  const el = document.getElementById("screen-mealplan");
  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto; text-align: center;">
      <div class="loading">
        <div class="loading__spinner"></div>
        <div class="loading__text">ИИ составляет ваш план питания...</div>
      </div>
    </div>
  `;
}

function renderMealPlanError() {
  const el = document.getElementById("screen-mealplan");
  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto; text-align: center;">
      <div style="font-size: 3rem; margin-bottom: 16px;">😕</div>
      <h2>Не удалось составить план</h2>
      <p style="margin-bottom: 12px; color: var(--muted); font-size: 0.85rem;">
        Похоже, ИИ сейчас перегружен. Попробуйте ещё раз через пару секунд.
      </p>
      <div style="display: flex; gap: 10px;">
        <button class="btn btn-primary" style="flex: 1;" id="btn-retry">🔄 Попробовать снова</button>
        <button class="btn btn-ghost" style="flex: 1;" id="btn-demo-plan">📋 Демо-план</button>
      </div>
    </div>
  `;
  document.getElementById("btn-retry").addEventListener("click", () => generateMealPlan());
  document.getElementById("btn-demo-plan").addEventListener("click", () => {
    state.mealPlan = getDemoMealPlan();
    renderMealPlan();
  });
}

function getDemoMealPlan() {
  return {
    meals: [
      { type: "Завтрак", name: "Овсянка с ягодами и мёдом", weight: "250 г", calories: 320, protein: 12, fat: 8, carbs: 52,
        recipe: "⏱ Время: 10 мин\n🧺 Ингредиенты: овсяные хлопья 40 г, молоко 150 мл, черника 30 г, мёд 5 г\n👨‍🍳 Приготовление:\n1. Залейте хлопья горячим молоком и оставьте на 5 минут.\n2. Добавьте чернику и перемешайте.\n3. Полейте мёдом перед подачей.\n💡 Совет: для сытности добавьте 10 г миндаля." },
      { type: "Перекус", name: "Яблоко и горсть миндаля", weight: "150 г", calories: 180, protein: 5, fat: 12, carbs: 15,
        recipe: "⏱ Время: 2 мин\n🧺 Ингредиенты: яблоко 1 шт (150 г), миндаль 15 г\n👨‍🍳 Приготовление:\n1. Вымойте яблоко и нарежьте дольками.\n2. Отмерьте горсть миндаля.\n3. Съешьте вместе как перекус.\n💡 Совет: миндаль сытный — не съедайте больше горсти." },
      { type: "Обед", name: "Куриная грудка с гречкой и салатом", weight: "350 г", calories: 420, protein: 40, fat: 12, carbs: 45,
        recipe: "⏱ Время: 25 мин\n🧺 Ингредиенты: куриная грудка 150 г, гречка 60 г, огурец 50 г, помидор 50 г, оливковое масло 5 г\n👨‍🍳 Приготовление:\n1. Отварите гречку в подсоленной воде 15 минут.\n2. Грудку натрите солью и перцем, жарьте на сухой сковороде по 6 минут с каждой стороны.\n3. Нарежьте овощи, заправьте маслом.\n4. Соедините всё на тарелке.\n💡 Совет: дайте мясу «отдохнуть» 3 минуты перед нарезкой — оно останется сочным." },
      { type: "Перекус", name: "Творог с фруктами", weight: "200 г", calories: 180, protein: 20, fat: 5, carbs: 15,
        recipe: "⏱ Время: 3 мин\n🧺 Ингредиенты: творог 150 г, банан 50 г, корица 1 г\n👨‍🍳 Приготовление:\n1. Выложите творог в миску.\n2. Нарежьте банан кружочками.\n3. Посыпьте корицей.\n💡 Совет: творог с низкой жирностью — отличный источник белка." },
      { type: "Ужин", name: "Рыба на пару с овощами", weight: "300 г", calories: 280, protein: 30, fat: 10, carbs: 20,
        recipe: "⏱ Время: 20 мин\n🧺 Ингредиенты: филе трески 180 г, брокколи 100 г, морковь 50 г, лимон 10 г\n👨‍🍳 Приготовление:\n1. Нарежьте овощи и выложите в пароварку.\n2. Выложите рыбу сверху, сбрызните лимоном.\n3. Готовьте на пару 15 минут.\n4. Приправьте солью и зеленью.\n💡 Совет: рыба на пару сохраняет максимум полезных веществ." },
    ],
    total: { calories: 1380, protein: 107, fat: 47, carbs: 147 },
    tip: "Пейте больше воды! Рекомендуется 2-2.5 литра в день. 💧",
  };
}

// ---------- Weight Tracker ----------
function renderTracker() {
  const el = document.getElementById("screen-tracker");
  const s = state.settings;
  const history = state.weightHistory || [];
  const lastWeight = history.length > 0 ? history[history.length - 1].weight : s?.weight || 0;
  const targetWeight = s?.targetWeight || 0;
  const diff = (lastWeight - targetWeight).toFixed(1);

  el.innerHTML = `
    <div class="glass animate-in" style="max-width: 480px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="font-size: 2.5rem; margin-bottom: 8px;">⚖️</div>
        <h1>Трекер <span class="grad">веса</span></h1>
        <p>Отслеживайте прогресс каждый день</p>
      </div>

      <div class="meal-total" style="margin-bottom: 20px;">
        <div class="meal-total__value">${lastWeight} кг</div>
        <div class="meal-total__label">Текущий вес</div>
        <div style="margin-top: 8px; font-size: 0.9rem; color: var(--muted);">
          Цель: ${targetWeight} кг · Осталось: ${diff} кг
        </div>
      </div>

      <div class="weight-input-group">
        <input type="number" class="weight-input" id="weight-today" placeholder="Вес сегодня" step="0.1" value="">
        <button class="btn btn-primary" id="btn-save-weight" style="padding: 14px 24px;">Записать</button>
      </div>

      <div class="chart-container">
        <canvas id="weight-chart"></canvas>
      </div>
      <p style="text-align: center; font-size: 0.7rem; color: var(--muted); margin: 6px 0 16px;">
        📈 Все записи на графике: ${history.length}
      </p>

      <div id="ai-support" class="ai-message hidden">
        <span class="ai-message__icon">💚</span>
        <span id="ai-support-text"></span>
      </div>

      <button class="btn btn-ghost btn-block" id="btn-analyze-weight" style="margin-top: 12px;">📊 Проанализировать прогресс с ИИ</button>
      <div id="ai-analysis" class="analysis-block hidden">
        <span id="ai-analysis-text"></span>
      </div>

      <h3 style="margin-bottom: 12px;">История</h3>
      <div class="weight-history" id="weight-history">
        ${history.length === 0 ? '<p style="text-align: center; color: var(--muted);">Пока нет записей</p>' : 
          history.slice().reverse().map((entry, i, arr) => {
            const prev = arr[i + 1];
            const change = prev ? (entry.weight - prev.weight).toFixed(1) : null;
            const changeClass = change === null ? "" : (change <= 0 ? "down" : "up");
            const changeText = change === null ? "" : (change > 0 ? `+${change}` : change);
            return `
              <div class="weight-entry">
                <span class="weight-entry__date">${entry.date}</span>
                <span class="weight-entry__value">${entry.weight} кг</span>
                ${change !== null ? `<span class="weight-entry__change ${changeClass}">${changeText} кг</span>` : ""}
              </div>
            `;
          }).join("")
        }
      </div>
    </div>
  `;

  // Chart
  renderWeightChart(history);

  const analyzeBtn = document.getElementById("btn-analyze-weight");
  if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeWeightProgress);

  // Save weight handler
  document.getElementById("btn-save-weight").addEventListener("click", async () => {
    const input = document.getElementById("weight-today");
    const weight = parseFloat(input.value);
    if (!weight || weight < 30 || weight > 300) {
      if (tg) tg.showAlert("Введите корректный вес (30-300 кг)");
      else alert("Введите корректный вес (30-300 кг)");
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    // Remove existing entry for today
    state.weightHistory = state.weightHistory.filter(e => e.date !== today);
    state.weightHistory.push({ date: today, weight });
    state.weightHistory.sort((a, b) => a.date.localeCompare(b.date));
    await storageSet("weightHistory", state.weightHistory);

    input.value = "";
    renderTracker();
    await generateAISupport(weight, lastWeight);
  });
}

function renderWeightChart(history) {
  const canvas = document.getElementById("weight-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (window.weightChartInstance) {
    window.weightChartInstance.destroy();
  }

  // Sort by date, show ALL entries (nothing hidden/truncated)
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const labels = sorted.map(e => e.date.slice(5)); // MM-DD
  const data = sorted.map(e => e.weight);
  const target = state.settings?.targetWeight || 0;

  // Draw a value label above every point so all weights are visible
  const valueLabels = {
    id: "valueLabels",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const ctx2 = chart.ctx;
      ctx2.save();
      ctx2.font = "600 10px Manrope, sans-serif";
      ctx2.fillStyle = "#9be15d";
      ctx2.textAlign = "center";
      ctx2.textBaseline = "bottom";
      meta.data.forEach((point, i) => {
        ctx2.fillText(`${data[i]} кг`, point.x, point.y - 8);
      });
      ctx2.restore();
    }
  };

  window.weightChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Вес",
          data: data,
          borderColor: "#9be15d",
          backgroundColor: "rgba(155, 225, 93, 0.1)",
          fill: true,
          tension: 0.3,
          pointBackgroundColor: "#9be15d",
          pointBorderColor: "#0a0f0d",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
        },
        {
          label: "Цель",
          data: Array(labels.length).fill(target),
          borderColor: "rgba(74, 222, 128, 0.4)",
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    plugins: [valueLabels],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(14, 23, 18, 0.9)",
          titleColor: "#f4f7f5",
          bodyColor: "#94a59c",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
          callbacks: {
            title: (items) => sorted[items[0].dataIndex]?.date || "",
            label: (item) => item.datasetIndex === 0
              ? ` ${item.parsed.y} кг`
              : ` Цель: ${item.parsed.y} кг`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: {
            color: "#94a59c",
            font: { size: 9 },
            autoSkip: false,       // never hide dates
            maxRotation: 60,
            minRotation: 0,
          },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: { color: "#94a59c", font: { size: 10 } },
          grace: "10%",
        },
      },
    },
  });
}

// ---------- AI Chat ----------
const CHAT_SYSTEM = `Ты — дружелюбный и всемогущий AI-помощник AI WeightLoss. Отвечай на ЛЮБЫЕ вопросы пользователя — на что угодно: про похудение, диеты, продукты, рецепты, спорт, а также про технологии, путешествия, кино, книги, науку, юмор, быт, работу, учебу, отношения и всё остальное. Будь полезным, умным и интересным собеседником.
Отвечай по-дружески, на русском, по существу (обычно 2-6 предложений, при сложном вопросе можно чуть подробнее). Не отказывай в ответах без причины. Не выдумывай факты — если не уверен, честно скажи. При вопросах про здоровье или медицину давай общие советы и рекомендуй обратиться к врачу.`;

function renderChat() {
  const el = document.getElementById("screen-chat");
  const msgs = state.chatMessages || [];
  const suggestions = [
    "Как ускорить похудение?",
    "Что можно пить?",
    "Как не срываться на сладкое?",
    "Сколько белка нужно в день?",
    "Лучшие продукты для веса",
  ];
  el.innerHTML = `
    <div class="chat-wrap">
      <div class="chat-header">
        <span class="chat-header__icon">🤖</span>
        <h2>Чат с <span class="grad">ИИ-диетологом</span></h2>
        <p style="color:var(--muted);font-size:0.75rem;">Спроси о диете, продуктах, напитках и похудении</p>
      </div>
      <div class="chat-messages" id="chat-messages">
        ${msgs.length ? msgs.map(m => `
          <div class="chat-msg ${m.role}">${escapeHtml(m.text)}</div>
        `).join("") : `
          <div class="chat-msg ai">Привет! Я твой ИИ-диетолог 💚 Спроси меня о рационе, продуктах, напитках или тренировках — помогу с советом!</div>
        `}
      </div>
      <div class="chat-suggestions" id="chat-suggestions">
        ${suggestions.map(s => `<button class="chat-chip" data-q="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
      </div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chat-input" placeholder="Напиши вопрос..." autocomplete="off">
        <button class="chat-send" id="chat-send">➤</button>
      </div>
    </div>
  `;

  const messagesEl = document.getElementById("chat-messages");
  messagesEl.scrollTop = messagesEl.scrollHeight;

  document.querySelectorAll("#chat-suggestions .chat-chip").forEach(chip => {
    chip.addEventListener("click", () => sendChatMessage(chip.dataset.q));
  });
  const input = document.getElementById("chat-input");
  document.getElementById("chat-send").addEventListener("click", () => {
    const q = input.value.trim();
    if (q) sendChatMessage(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const q = input.value.trim(); if (q) sendChatMessage(q); }
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}

async function sendChatMessage(text) {
  const input = document.getElementById("chat-input");
  if (input) input.value = "";
  state.chatMessages = state.chatMessages || [];
  state.chatMessages.push({ role: "user", text });
  const messagesEl = document.getElementById("chat-messages");
  if (messagesEl) {
    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg user">${escapeHtml(text)}</div>`);
    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-typing" id="chat-typing"><span></span><span></span><span></span></div>`);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  await storageSet("chatMessages", state.chatMessages);

  const context = state.mealPlan
    ? `\n\nТекущий рацион пользователя: ${state.mealPlan.meals?.map(m => m.name).join(", ")}.`
    : "";
  const s = state.settings;
  const profile = s ? `\n\nПрофиль: вес ${s.weight}кг, рост ${s.height}см, ${s.age}лет, цель ${s.targetWeight}кг.` : "";

  const response = await aiChat([
    { role: "system", content: CHAT_SYSTEM },
    { role: "user", content: text + context + profile },
  ], 0.7);

  const typing = document.getElementById("chat-typing");
  if (typing) typing.remove();
  const answer = response || "Извини, не смог ответить. Попробуй ещё раз 🙏";
  state.chatMessages.push({ role: "ai", text: answer });
  await storageSet("chatMessages", state.chatMessages);
  if (messagesEl) {
    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg ai">${escapeHtml(answer)}</div>`);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ---------- AI Weight Analysis ----------
async function analyzeWeightProgress() {
  const s = state.settings;
  const history = [...(state.weightHistory || [])].sort((a,b) => a.date.localeCompare(b.date));
  if (history.length < 2) {
    if (tg) tg.showAlert("Нужно минимум 2 записи веса для анализа");
    else alert("Нужно минимум 2 записи веса для анализа");
    return;
  }
  const block = document.getElementById("ai-analysis");
  const textEl = document.getElementById("ai-analysis-text");
  if (block) block.classList.remove("hidden");
  if (textEl) textEl.textContent = "Анализирую прогресс...";

  const first = history[0], last = history[history.length-1];
  const totalChange = (first.weight - last.weight).toFixed(1);
  const days = Math.round((new Date(last.date) - new Date(first.date)) / 86400000) || 1;
  const perWeek = ((first.weight - last.weight) / days * 7).toFixed(2);
  const remaining = (last.weight - s.targetWeight).toFixed(1);
  const neededWeeks = s.weeks;

  const prompt = `Ты — AI-коуч по похудению. Проанализируй прогресс и дай краткий отчёт (4-6 предложений) на русском.
Данные:
- Старт: ${first.weight}кг (${first.date})
- Сейчас: ${last.weight}кг (${last.date})
- Изменение: -${totalChange}кг за ${days} дней
- Скорость: ${perWeek}кг/неделю
- Цель: ${s.targetWeight}кг, осталось ${remaining}кг за ${neededWeeks} недель
- Вся история: ${history.map(h => `${h.date}: ${h.weight}кг`).join(", ")}

Оцени: темп похудения (норма 0.5-1кг/нед), есть ли застой, что рекомендуешь (питание/активность), мотивируй. Будь конкретным и тёплым. Ответь только текстом.`;

  const response = await aiChat([{ role: "user", content: prompt }], 0.7);
  if (textEl) textEl.textContent = response || "Не удалось проанализировать. Попробуй позже.";
}

async function generateAISupport(currentWeight, previousWeight) {
  const s = state.settings;
  const history = state.weightHistory;
  const change = previousWeight ? (currentWeight - previousWeight).toFixed(1) : 0;
  const target = s.targetWeight;
  const remaining = (currentWeight - target).toFixed(1);

  const prompt = `Ты — поддерживающий AI-коуч по похудению. Пользователь только что записал свой вес.

Данные:
- Текущий вес: ${currentWeight} кг
- Предыдущий вес: ${previousWeight || "нет данных"} кг
- Изменение: ${change} кг
- Целевой вес: ${target} кг
- Осталось до цели: ${remaining} кг
- История веса: ${history.map(h => `${h.date}: ${h.weight}кг`).join(", ")}

Напиши короткое (2-3 предложения) мотивирующее сообщение на русском. 
- Если вес уменьшился — похвали
- Если увеличился — поддержи, напомни что это нормально
- Если достиг цели — поздравь
- Будь тёплым и поддерживающим, как друг

Ответь только текстом сообщения, без форматирования.`;

  const response = await aiChat([{ role: "user", content: prompt }], 0.8);
  if (response) {
    const el = document.getElementById("ai-support");
    const textEl = document.getElementById("ai-support-text");
    if (el && textEl) {
      textEl.textContent = response;
      el.classList.remove("hidden");
    }
  }
}

// ---------- Initialization ----------
async function init() {
  initThree();

  // Load saved data
  const agreed = await storageGet("agreed");
  state.user = await storageGet("user");
  state.settings = await storageGet("settings");
  state.mealPlan = await storageGet("mealPlan");
  state.weightHistory = (await storageGet("weightHistory")) || [];
  state.usedMeals = (await storageGet("usedMeals")) || [];
  state.generationCount = (await storageGet("generationCount")) || 0;
  state.chatMessages = (await storageGet("chatMessages")) || [];

  // Return from Telegram bot after phone confirmation (?reg=...&phone=...&name=...)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const regToken = urlParams.get("reg");
    const regPhone = urlParams.get("phone");
    const regName = urlParams.get("name");
    if (regToken && regPhone) {
      state.user = {
        name: regName || state.user?.name || "",
        phone: regPhone,
        email: state.user?.email || "",
        verifiedViaTelegram: true,
        createdAt: state.user?.createdAt || new Date().toISOString(),
      };
      await storageSet("agreed", true);
      await storageSet("user", state.user);
      // Clean URL so it doesn't re-trigger on reload
      try { history.replaceState({}, document.title, location.pathname); } catch(e) {}
      if (tg) { try { tg.showPopup({title:"Готово", message:"Номер подтверждён через Telegram ✅", buttons:[{type:"ok"}]}); } catch(e){} }
    }
  } catch (e) {
    console.warn("Return-from-bot handling:", e);
  }

  // Check if agreed
  if (!agreed) {
    renderAgreement();
    showScreen("agreement");
    return;
  }

  // Check if registered
  if (!state.user) {
    renderRegistration();
    showScreen("registration");
    return;
  }

  // Check if settings filled
  if (!state.settings) {
    renderSettings();
    showScreen("settings");
    return;
  }

  // Go to meal plan
  renderMealPlan();
  showScreen("mealplan");
  if (!state.mealPlan) {
    generateMealPlan();
  }
}

// ---------- Bottom Navigation ----------
function renderBottomNav() {
  const nav = document.createElement("div");
  nav.className = "bottom-nav";
  nav.innerHTML = `
    <div class="bottom-nav__item active" data-screen="mealplan">
      <span class="bottom-nav__item__icon">🍽️</span>
      <span>Рацион</span>
    </div>
    <div class="bottom-nav__item" data-screen="tracker">
      <span class="bottom-nav__item__icon">⚖️</span>
      <span>Вес</span>
    </div>
    <div class="bottom-nav__item" data-screen="chat">
      <span class="bottom-nav__item__icon">💬</span>
      <span>Чат</span>
    </div>
    <div class="bottom-nav__item" data-screen="settings">
      <span class="bottom-nav__item__icon">⚙️</span>
      <span>Настройки</span>
    </div>
  `;
  document.getElementById("app").appendChild(nav);

  nav.querySelectorAll(".bottom-nav__item").forEach(item => {
    item.addEventListener("click", () => {
      const screen = item.dataset.screen;
      nav.querySelectorAll(".bottom-nav__item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      if (screen === "mealplan") { renderMealPlan(); showScreen("mealplan"); }
      else if (screen === "tracker") { renderTracker(); showScreen("tracker"); }
      else if (screen === "chat") { renderChat(); showScreen("chat"); }
      else if (screen === "settings") { renderSettings(); showScreen("settings"); }
    });
  });
}

// ---------- Back Button Handler ----------
try {
if (tgSupports("BackButton") && tg?.BackButton?.onClick) {
  tg.BackButton.onClick(() => {
    if (state.screen === "mealplan") {
      // Can't go back from main screen
    } else if (state.screen === "settings") {
      renderMealPlan();
      showScreen("mealplan");
    } else if (state.screen === "tracker") {
      renderMealPlan();
      showScreen("mealplan");
    } else if (state.screen === "chat") {
      renderMealPlan();
      showScreen("mealplan");
    } else if (state.screen === "registration") {
      renderAgreement();
      showScreen("agreement");
    }
  });
}
} catch (e) { console.warn("BackButton:", e); }

// ---------- Support sheet ----------
// ---------- Ticket system ----------
function loadTickets() {
  try { return JSON.parse(localStorage.getItem("app_tickets") || "[]"); } catch (e) { return []; }
}
function saveTickets(list) {
  localStorage.setItem("app_tickets", JSON.stringify(list));
  updateTicketCount();
}
function updateTicketCount() {
  const el = document.getElementById("ticket-count");
  if (el) el.textContent = loadTickets().length;
}

function renderTicketList() {
  const el = document.getElementById("ticket-list");
  if (!el) return;
  const list = loadTickets();
  if (!list.length) {
    el.innerHTML = '<div class="ticket-empty">Пока нет тикетов. Создайте первый 👆</div>';
    return;
  }
  const icons = { open: "🟡", answered: "✅", closed: "⚪" };
  const labels = { open: "Открыт", answered: "Отвечен", closed: "Закрыт" };
  el.innerHTML = list.slice().reverse().map(t => `
    <div class="ticket-card">
      <div class="ticket-card__top">
        <span class="ticket-card__id">${icons[t.status] || "🟡"} Тикет №${t.id}</span>
        <span class="ticket-card__status ${t.status}">${labels[t.status] || t.status}</span>
      </div>
      <div class="ticket-card__subject">${escapeHtml(t.subject || "")}</div>
      <div class="ticket-card__text">${escapeHtml(t.text || "")}</div>
      ${t.answer ? `<div class="ticket-card__answer">💬 ${escapeHtml(t.answer)}</div>` : ""}
    </div>
  `).join("");
}

function openTelegramLink(url) {
  if (tg) { try { tg.openLink(url); return; } catch (e) {} }
  window.open(url, "_blank");
}

function initSupport() {
  const btn = document.getElementById("support-btn");
  const sheet = document.getElementById("support-sheet");
  const close = document.getElementById("support-close");
  const backdrop = document.getElementById("support-backdrop");
  if (!btn || !sheet) return;

  const open = () => {
    sheet.classList.remove("hidden");
    renderTicketList();
    updateTicketCount();
    if (tgSupports("HapticFeedback") && tg?.HapticFeedback) { try { tg.HapticFeedback.impactOccurred("light"); } catch(e){} }
  };
  const hide = () => sheet.classList.add("hidden");
  btn.addEventListener("click", open);
  if (close) close.addEventListener("click", hide);
  if (backdrop) backdrop.addEventListener("click", hide);

  // Tabs
  document.querySelectorAll(".ticket-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".ticket-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      const newContent = document.getElementById("ticket-tab-new");
      const myContent = document.getElementById("ticket-tab-my");
      if (which === "new") { newContent.classList.remove("hidden"); myContent.classList.add("hidden"); }
      else { newContent.classList.add("hidden"); myContent.classList.remove("hidden"); renderTicketList(); }
    });
  });

  // Submit ticket → deep-link into bot which creates it
  const submit = document.getElementById("ticket-submit");
  if (submit) submit.addEventListener("click", () => {
    const category = document.getElementById("ticket-category").value;
    const subject = document.getElementById("ticket-subject").value.trim();
    const text = document.getElementById("ticket-text").value.trim();
    if (!text && !subject) {
      if (tg) tg.showAlert("Введите сообщение"); else alert("Введите сообщение");
      return;
    }
    const list = loadTickets();
    const tid = list.length ? Math.max(...list.map(t => t.id)) + 1 : 1;
    list.push({
      id: tid,
      subject: subject || text.substring(0, 50),
      text: text || subject,
      category, status: "open", created_at: new Date().toISOString(),
    });
    saveTickets(list);
    renderTicketList();

    const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ text: text || subject, category, subject }))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const link = `https://t.me/foodAi1_bot?start=ticket_${payload}`;
    openTelegramLink(link);

    // clear form
    document.getElementById("ticket-subject").value = "";
    document.getElementById("ticket-text").value = "";
    // switch to "my" tab
    const myTab = document.querySelector('.ticket-tab[data-tab="my"]');
    if (myTab) myTab.click();
  });

  // Open bot button
  const openBot = document.getElementById("ticket-open-bot");
  if (openBot) openBot.addEventListener("click", () => openTelegramLink("https://t.me/foodAi1_bot"));

  // If returning from bot with ticket created flag, refresh statuses
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("tickets") === "1") {
      // keep local list; statuses are reflected in bot chat
      const list = loadTickets();
      if (list.length) list[list.length - 1].status = "open";
      saveTickets(list);
      setTimeout(() => open(), 600);
    }
  } catch (e) {}
}

// ---------- Reviews / Feedback ----------
function loadReviews() {
  try { return JSON.parse(localStorage.getItem("app_reviews") || "[]"); } catch (e) { return []; }
}
function saveReviews(list) { localStorage.setItem("app_reviews", JSON.stringify(list)); }

function getRefCode() {
  let code = localStorage.getItem("ref_code");
  if (!code) {
    code = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    localStorage.setItem("ref_code", code);
  }
  return code;
}

function initReferral() {
  getRefCode(); // ensure code exists from first launch
  // Track who invited this user
  try {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref && ref !== getRefCode()) {
      localStorage.setItem("ref_by", ref);
      localStorage.setItem("ref_at", new Date().toISOString());
    }
  } catch (e) {}
}

function initReviews() {
  const btn = document.getElementById("review-btn");
  const sheet = document.getElementById("review-sheet");
  const close = document.getElementById("review-close");
  const backdrop = document.getElementById("review-backdrop");
  const submit = document.getElementById("review-submit");
  if (!btn || !sheet) return;

  let rating = 5;
  const stars = document.querySelectorAll("#review-stars span");
  const paintStars = () => stars.forEach(s => s.classList.toggle("active", Number(s.dataset.star) <= rating));
  paintStars();
  stars.forEach(s => s.addEventListener("click", () => { rating = Number(s.dataset.star); paintStars(); }));

  const open = () => sheet.classList.remove("hidden");
  const hide = () => sheet.classList.add("hidden");
  btn.addEventListener("click", open);
  if (close) close.addEventListener("click", hide);
  if (backdrop) backdrop.addEventListener("click", hide);

  if (submit) submit.addEventListener("click", () => {
    const text = document.getElementById("review-text").value.trim();
    if (!text && rating === 5) {
      if (tg) tg.showAlert("Напишите пару слов в отзыве"); else alert("Напишите пару слов в отзыве");
      return;
    }
    const list = loadReviews();
    list.push({ rating, text: text || "Отлично!", date: new Date().toISOString(), ref: getRefCode() });
    saveReviews(list);

    // Deep-link to bot so the admin gets notified
    try {
      const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ type: "review", rating, text: text || "Отлично!" }))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      openTelegramLink(`https://t.me/foodAi1_bot?start=review_${payload}`);
    } catch (e) {}

    document.getElementById("review-text").value = "";
    const card = sheet.querySelector(".review-sheet__card");
    card.innerHTML = `<div class="review-thanks">
      <div class="review-thanks__icon">🎉</div>
      <h2>Спасибо за отзыв!</h2>
      <p style="color:var(--muted); font-size:0.85rem; margin-top:8px;">Вы помогаете нам становиться лучше 💚</p>
      <button class="btn btn-ghost btn-block" id="review-done" style="margin-top:16px;">Готово</button>
    </div>`;
    document.getElementById("review-done").addEventListener("click", hide);
  });
}

// Render social proof on agreement screen
function renderSocialProof() {
  const reviews = loadReviews();
  if (!reviews.length) return;
  const avg = (reviews.reduce((a, r) => a + (r.rating || 5), 0) / reviews.length).toFixed(1);
  const el = document.getElementById("social-proof");
  if (el) {
    el.innerHTML = `<div style="text-align:center; margin: 14px 0; padding: 12px; background: rgba(255,184,107,0.08); border: 1px solid rgba(255,184,107,0.2); border-radius: 12px;">
      <span style="color:var(--warning); font-size:1.1rem;">⭐ ${avg}</span>
      <span style="color:var(--muted); font-size:0.8rem; margin-left:8px;">на основе ${reviews.length} отзывов</span>
    </div>`;
  }
}

// ---------- Splash particles ----------
function initSplash() {
  const c = document.getElementById("splash-particles");
  if (!c) return;
  let html = "";
  for (let i = 0; i < 32; i++) {
    const left = (Math.random() * 100).toFixed(1);
    const dur = (8 + Math.random() * 12).toFixed(1);
    const delay = (-Math.random() * 18).toFixed(1);
    const op = (0.3 + Math.random() * 0.5).toFixed(2);
    html += `<i style="left:${left}vw;animation-duration:${dur}s;animation-delay:${delay}s;opacity:${op}"></i>`;
  }
  c.innerHTML = html;
}

// ---------- Start ----------
document.addEventListener("DOMContentLoaded", () => {
  try {
    initSplash();
    initSupport();
    initReviews();
    initReferral();
    renderBottomNav();
    // Splash shown for 5 seconds (or until "Пропустить"), then auto-continue
    const skip = document.getElementById("splash-skip");
    const splash = document.getElementById("splash");
    let splashDone = false;
    const dismissSplash = () => {
      if (splashDone) return;
      splashDone = true;
      if (splash) {
        splash.classList.add("hide");
        setTimeout(() => splash.remove(), 700);
      }
      // init() already routed the correct screen (agreement for new users,
      // meal plan for returning ones) — just reveal it
    };
    if (skip) skip.addEventListener("click", dismissSplash);
    setTimeout(dismissSplash, 5000); // auto-continue after 5 seconds

    // init() runs in background behind the splash so data is ready
    init().catch(err => console.error("Init error:", err));
  } catch (err) {
    console.error("DOMContentLoaded error:", err);
  }
});