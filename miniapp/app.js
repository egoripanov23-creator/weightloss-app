// ============================================================
// AI WeightLoss Mini App — Main Application
// ============================================================

// ---------- Configuration ----------
// Shared AI endpoints (NO per-user API key required — works for everyone)
// OpenAI-compatible, CORS enabled, free. Trying in order until one works.
const AI_ENDPOINTS = [
  { url: "https://api.keysaiapifree.com/v1/chat/completions", model: "free-ai" },
  { url: "https://api.aikeyfreeapi.com/v1/chat/completions", model: "free-ai" },
  { url: "https://api.freeapillmkey.com/v1/chat/completions", model: "free-ai" },
];
const AI_TIMEOUT_MS = 12000; // fast fail — AI should never hang for minutes

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
if (tg) {
  try { tg.ready(); } catch (e) { console.warn("tg.ready:", e); }
  try { tg.expand(); } catch (e) { console.warn("tg.expand:", e); }
  try { tg.setHeaderColor("#0a0f0d"); } catch (e) { console.warn("tg.setHeaderColor:", e); }
  try { tg.setBackgroundColor("#0a0f0d"); } catch (e) { console.warn("tg.setBackgroundColor:", e); }
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
  aiMessages: [],
  isLoading: false,
};

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
// Shared endpoints — no key input, no per-user setup. Fast + CORS-enabled.
async function aiChat(messages, temperature = 0.7) {
  for (const ep of AI_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer free" },
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
        const content = data.choices?.[0]?.message?.content || "";
        if (content) {
          state.lastApiError = null;
          return content;
        }
      } else {
        const txt = await res.text().catch(() => "");
        state.lastApiError = `HTTP ${res.status}: ${txt.substring(0, 120)}`;
        console.warn(`AI ${ep.url} -> ${res.status}`);
      }
    } catch (err) {
      clearTimeout(timeout);
      state.lastApiError = err?.name === "AbortError" ? "Таймаут (сервер не ответил)" : (err?.message || "Ошибка сети");
      console.warn(`AI ${ep.url} error:`, err?.message);
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
  try { if (tg?.BackButton) tg.BackButton.isVisible = (name !== "agreement" && name !== "mealplan"); } catch (e) {}
  
  // Haptic feedback
  try { if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred("light"); } catch (e) {}
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
      <label class="agreement-checkbox">
        <input type="checkbox" id="agree-checkbox">
        <span>Я принимаю условия пользовательского соглашения</span>
      </label>
      <button class="btn btn-primary btn-block" id="btn-agree" disabled>Продолжить</button>
    </div>
  `;
  
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
        <div style="display: flex; gap: 10px; align-items: center;">
          <input type="tel" class="form-input" id="reg-phone" placeholder="+7 999 123-45-67" value="${state.user?.phone || ""}" style="flex: 1;">
          ${tg ? '<button class="btn btn-ghost btn-sm" id="btn-share-phone" style="white-space: nowrap; flex-shrink: 0;">📱 Из Telegram</button>' : ""}
        </div>
        <p style="font-size: 0.75rem; color: var(--muted); margin-top: 6px;">Обязательно для регистрации</p>
      </div>
      <div class="form-group">
        <label class="form-label">Email (необязательно)</label>
        <input type="email" class="form-input" id="reg-email" placeholder="your@email.com" value="${state.user?.email || ""}">
      </div>
      <button class="btn btn-primary btn-block" id="btn-register">Продолжить к настройкам</button>
    </div>
  `;
  
  // Share phone from Telegram
  if (tg) {
    const shareBtn = document.getElementById("btn-share-phone");
    if (shareBtn) {
      shareBtn.addEventListener("click", () => {
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
      });
    }
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
      if (tg) tg.showAlert("Введите номер телефона (минимум 10 цифр)");
      else alert("Введите номер телефона (минимум 10 цифр)");
      return;
    }

    state.user = { name, phone, email, createdAt: new Date().toISOString() };
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

      <p style="text-align: center; font-size: 0.75rem; color: var(--muted); margin: 16px 0 8px;">
        🤖 ИИ работает автоматически — ключ не нужен
      </p>

      <button class="btn btn-primary btn-block" id="btn-save-start">💾 Сохранить и начать</button>
    </div>
  `;

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

    state.settings = {
      weight, height, age, targetWeight, weeks, products, allergies, difficulty: diff,
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

  state.generationCount += 1;
  await storageSet("generationCount", state.generationCount);

  const exclude = state.usedMeals.slice(-60);
  const excludeText = exclude.length
    ? `\n❌ КАТЕГОРИЧЕСКИ НЕ ПОВТОРЯЙ эти блюда (уже были раньше): ${exclude.join("; ")}. Придумай полностью новые названия и другие способы приготовления.`
    : "";
  // Variety clue: different cuisine / technique each time
  const themes = [
    "используй запекание и свежие травы",
    "используй варку на пару и лимон",
    "используй жарку на сухой сковороде и специи",
    "используй тушение и коренья",
    "используй сырые овощи и лёгкие соусы",
    "используй гриль и пряности",
  ];
  const theme = themes[state.generationCount % themes.length];

  let data = null;
  let lastErr = null;
  // Up to 3 attempts — keep asking until we get a plan with zero repeats
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    const extraBan = state._lastRejected?.length
      ? `\n🚫 Особенно НЕ используй: ${state._lastRejected.join("; ")}.` : "";
    const prompt = `Ты диетолог. Составь НОВЫЙ план питания на 1 день (вариант №${state.generationCount}). Отвечай ТОЛЬКО валидным JSON, без текста до и после.

Данные: вес ${s.weight}кг, рост ${s.height}см, возраст ${s.age}, цель ${s.targetWeight}кг за ${s.weeks}нед. Продукты: ${products.join(", ") || "любые"}. Аллергии: ${allergies.join(", ") || "нет"}. Сложность: ${diff?.name || "средняя"}. Стиль этого варианта: ${theme}.${excludeText}${extraBan}

ПРАВИЛА:
- type — ТОЛЬКО русские слова: "Завтрак", "Перекус", "Обед", "Перекус", "Ужин" (НЕ breakfast/lunch/dinner!)
- name — ПРИДУМАЙ НОВОЕ/original название блюда, не из списка запрещённых
- weight — строка вида "200 г"
- recipe — коротко 2-3 шага на русском
- 5 приёмов пищи, дефицит ~500 ккал

Формат (только JSON):
{"meals":[{"type":"Завтрак","name":"Блюдо","weight":"200 г","calories":350,"protein":25,"fat":10,"carbs":40,"recipe":"1. Шаг\\n2. Шаг"}],"total":{"calories":1500,"protein":100,"fat":50,"carbs":150},"tip":"Совет на русском"}`;

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
    console.error("Meal plan error:", lastErr);
    state.lastError = lastErr?.message || String(lastErr);
    renderMealPlanError();
    return;
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
              <summary>📖 Рецепт приготовления</summary>
              <div class="meal-card__recipe-text">${m.recipe}</div>
            </details>
          ` : ""}
        </div>
      `).join("") || ""}

      ${plan.tip ? `<div class="ai-message"><span class="ai-message__icon">💡</span>${plan.tip}</div>` : ""}

      <div style="display: flex; gap: 12px; margin-top: 20px;">
        <button class="btn btn-ghost btn-block" id="btn-regenerate">🔄 Составить ещё раз</button>
      </div>
    </div>
  `;

  document.getElementById("btn-regenerate").addEventListener("click", () => {
    generateMealPlan();
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
        ИИ временно недоступен. Попробуйте ещё раз через пару секунд.
      </p>
      ${state.lastApiError ? `<p style="font-size: 0.7rem; color: #ff6b6b; margin-bottom: 12px; word-break: break-all;">${state.lastApiError}</p>` : ""}
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
  const s = state.settings;
  return {
    meals: [
      { type: "Завтрак", name: "Овсянка с ягодами и мёдом", weight: "250 г", calories: 320, protein: 12, fat: 8, carbs: 52 },
      { type: "Перекус", name: "Яблоко и горсть миндаля", weight: "150 г", calories: 180, protein: 5, fat: 12, carbs: 15 },
      { type: "Обед", name: "Куриная грудка с гречкой и салатом", weight: "350 г", calories: 420, protein: 40, fat: 12, carbs: 45 },
      { type: "Перекус", name: "Творог с фруктами", weight: "200 г", calories: 180, protein: 20, fat: 5, carbs: 15 },
      { type: "Ужин", name: "Рыба на пару с овощами", weight: "300 г", calories: 280, protein: 30, fat: 10, carbs: 20 },
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

      <div id="ai-support" class="ai-message hidden">
        <span class="ai-message__icon">💚</span>
        <span id="ai-support-text"></span>
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

  const labels = history.map(e => e.date.slice(5)); // MM-DD
  const data = history.map(e => e.weight);
  const target = state.settings?.targetWeight || 0;

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
          tension: 0.4,
          pointBackgroundColor: "#9be15d",
          pointBorderColor: "#0a0f0d",
          pointBorderWidth: 2,
          pointRadius: 5,
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
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(14, 23, 18, 0.9)",
          titleColor: "#f4f7f5",
          bodyColor: "#94a59c",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: { color: "#94a59c", font: { size: 10 } },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: { color: "#94a59c", font: { size: 10 } },
        },
      },
    },
  });
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
      else if (screen === "settings") { renderSettings(); showScreen("settings"); }
    });
  });
}

// ---------- Back Button Handler ----------
try {
if (tg?.BackButton?.onClick) {
  tg.BackButton.onClick(() => {
    if (state.screen === "mealplan") {
      // Can't go back from main screen
    } else if (state.screen === "settings") {
      renderMealPlan();
      showScreen("mealplan");
    } else if (state.screen === "tracker") {
      renderMealPlan();
      showScreen("mealplan");
    } else if (state.screen === "registration") {
      renderAgreement();
      showScreen("agreement");
    }
  });
}
} catch (e) { console.warn("BackButton:", e); }

// ---------- Start ----------
document.addEventListener("DOMContentLoaded", () => {
  try {
    init().catch(err => console.error("Init error:", err));
    renderBottomNav();
  } catch (err) {
    console.error("DOMContentLoaded error:", err);
  }
});