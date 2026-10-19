/**
 * Cloudflare Worker for AI Weekly Meal Planner (AI 個人化每週料理規劃 - 小資日嚐)
 * Secure proxy to Google Gemini API
 * 
 * Supported Actions:
 * - 'generate_week'    : 規劃一週七日晚餐菜單
 * - 'replace_day'       : 單日晚餐替換候選料理推薦
 * - 'generate_recipes' : 生成 5 道全新、不重複且符合個人偏好與過敏排除的一人份料理食譜
 * - 'ping'             : 快速健康檢查與支援功能探測
 * 
 * Features:
 * - Full CORS support for GitHub Pages (tuki0527.github.io), localhost, and custom domains
 * - Payload size limit protection (50KB)
 * - Safe API Key reading from Cloudflare Worker Secrets (env.GEMINI_API_KEY)
 * - Multi-model fallback: tries Gemini 2.5 Flash then 2.5 Flash Lite on transient errors
 * - Strict JSON extraction & markdown fence stripping
 * - Error isolation protecting sensitive credentials
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const SUPPORTED_ACTIONS = ['generate_week', 'replace_day', 'generate_recipes', 'ping'];
const CANDIDATE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function normalizeName(value) {
  return String(value || '').normalize('NFKC').replace(/[\s、，,。．.・\-—_]/g, '').toLowerCase();
}

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2. Enforce POST method
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed. Only POST is accepted.' }),
        { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Payload size limit (50KB limit to accommodate rich ingredient & history payload)
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 50000) {
      return new Response(
        JSON.stringify({ error: 'Payload too large. Maximum size is 50KB.' }),
        { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Verify API Key is provisioned in Cloudflare Secrets
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'Cloudflare Worker 尚未設定 GEMINI_API_KEY Secret。請至 Cloudflare 後台 Settings -> Variables and Secrets 新增 GEMINI_API_KEY。',
          code: 'MISSING_API_KEY',
        }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 5. Parse and validate JSON input
    let requestData;
    try {
      requestData = await request.json();
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON payload.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const {
      action,
      preferences,
      availableRecipes,
      dates,
      currentDishId,
      targetDate,
      existingRecipeNames,
      mealHistorySummary,
      availableIngredients,
    } = requestData;

    if (!action || !SUPPORTED_ACTIONS.includes(action)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid action. Supported actions: generate_week, replace_day, generate_recipes, ping.',
          supportedActions: SUPPORTED_ACTIONS,
        }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 6. Fast Health Ping Check
    if (action === 'ping') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          message: 'Cloudflare Worker 代理運行正常',
          supportedActions: SUPPORTED_ACTIONS,
          models: CANDIDATE_MODELS,
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 7. Build the specialized prompt for Gemini
    const systemInstruction = `你是一位專業的個人化營養與料理規劃大師。
重要規則：
1. 嚴格輸出合法的純 JSON 格式，不得包含任何 Markdown 代碼塊（例如絕不要用 \`\`\`json 包覆），直接輸出純 JSON。
2. 絕對不可推薦包含使用者忌口或過敏原 (allergens) 的料理！若偏好與過敏衝突，過敏安全為最高絕對優先。
3. 兼顧蛋白質來源多樣性（雞肉、豬肉、海鮮、豆腐、蛋類）與一人份烹調便利性。`;

    let userPrompt = '';

    // Action 1: 七日菜單生成 (完全保護既有功能)
    if (action === 'generate_week') {
      userPrompt = `請為以下偏好規劃 7 天晚餐（固定一人份）：
- 使用者飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 喜愛食材：${(preferences?.likedIngredients || []).join(', ') || '無特別指定'}
- 討厭食材：${(preferences?.dislikedIngredients || []).join(', ') || '無'}
- 過敏與絕對排除：${(preferences?.allergens || []).join(', ') || '無'}
- 偏好類型：${preferences?.cuisineStyle || '家常台式/日式定食'}
- 週預算目標：NT$ ${preferences?.budget || 1000}
- 需要排定的日期（週一至週日）：${(dates || []).join(', ')}

候選有效料理清單（包含 ID、名稱、主要食材、分類）：
${JSON.stringify(availableRecipes, null, 1)}

請嚴格輸出符合以下結構的純 JSON 格式：
{
  "mode": "ai",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "recipeId": "rec_xxx",
      "reason": "具體說明推薦原因與食材共用優勢（20字以內繁體中文）"
    }
  ]
}`;
    }
    // Action 2: 單餐替換 (完全保護既有功能)
    else if (action === 'replace_day') {
      userPrompt = `使用者想要替換 ${targetDate} 的晚餐料理（原料理 ID: ${currentDishId}）。
- 使用者飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 過敏與絕對排除：${(preferences?.allergens || []).join(', ') || '無'}
- 偏好料理類型：${preferences?.cuisineStyle || '無'}

候選料理清單：
${JSON.stringify(availableRecipes, null, 1)}

請挑選 2 到 3 道最適合的替代料理，直接輸出純 JSON 格式：
{
  "mode": "ai",
  "candidates": [
    {
      "recipeId": "rec_xxx",
      "reason": "替換優勢說明，例如低卡清爽或共用現有食材（20字以內繁體中文）"
    }
  ]
}`;
    }
    // Action 3: AI 生成 5 道料理 (新增功能)
    else if (action === 'generate_recipes') {
      const existingListStr = (existingRecipeNames || []).join('、');
      const allergensStr = (preferences?.allergens || []).join('、') || '無';
      const dislikedStr = (preferences?.dislikedIngredients || []).join('、') || '無';
      const likedStr = (preferences?.likedIngredients || []).join('、') || '無特別指定';
      const historyStr = mealHistorySummary
        ? `常吃/高頻料理: ${(mealHistorySummary.frequentDishes || []).join('、') || '無'}；高評分料理: ${(mealHistorySummary.highRatedDishes || []).join('、') || '無'}`
        : '無歷史紀錄（請生成多樣化料理，涵蓋台式家常、日式定食、韓式風味、清爽輕食、暖胃湯料理等）';

      userPrompt = `請為單人晚餐規劃產生【剛好 5 道】全新、具備多樣性的一人份料理食譜。

【使用者條件】
- 飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 偏好風格：${preferences?.cuisineStyle || '多樣家常'}
- 喜愛食材：${likedStr}
- 歷史用餐回饋：${historyStr}
- 🚫 嚴格排除過敏原（絕對不可包含）：${allergensStr}
- 🚫 忌口避開食材：${dislikedStr}

【重複限制（非常重要）】
1. 本次生成的 5 道料理之間不得重複。
2. 絕對不可與以下現有料理重複或僅改菜名：${existingListStr}
3. 必須涵蓋不同蛋白質（雞、豬、海鮮、豆腐、蛋）與烹調方式（煎、炒、燉、煲、蒸）。

【現有超市食材庫參考（可優先使用以下食材，亦可新增常見超市食材）】
${JSON.stringify(availableIngredients || [], null, 1)}

請直接回傳符合以下 JSON 格式（剛好 5 道料理）：
{
  "mode": "ai",
  "recipes": [
    {
      "name": "料理名稱（繁體中文，具體吸引人，不可與既有名稱重複）",
      "category": "料理類別（如：家常台式、日式定食、異國風味、暖胃湯料理、清爽輕食、韓式料理）",
      "description": "25字以內料理特色與口感介紹",
      "cookTimeMinutes": 20,
      "primaryProtein": "chicken 或 pork 或 seafood 或 tofu 或 egg 或 other",
      "tags": ["AI 生成", "特色標籤1", "特色標籤2"],
      "allergens": ["若含有大豆、雞蛋、海鮮魚類、甲殼海鮮請列出，無則空陣列"],
      "ingredients": [
        {
          "name": "食材名稱（如：去骨雞腿排、洋蔥、綠花椰菜、純釀造醬油、蒜頭）",
          "ingredientId": "若對應現有食材請填現有ID，若為新食材可為空字串",
          "amount": 150,
          "unit": "g 或 顆 或 份 或 ml",
          "isPantry": false,
          "estimatedKcal": 180,
          "estimatedCost": 45
        }
      ],
      "steps": [
        "步驟 1：詳細洗切備料說明...",
        "步驟 2：烹調下鍋與火候說明...",
        "步驟 3：調味與收汁說明...",
        "步驟 4：起鍋擺盤與食用建議..."
      ]
    }
  ]
}`;
    }

    // 8. Call Gemini with multi-model fallback and timeout protection
    let lastError = null;
    let geminiResult = null;

    for (const modelName of CANDIDATE_MODELS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      try {
        const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        const geminiPayload = {
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: action === 'generate_recipes' ? 8192 : 4096,
            responseMimeType: 'application/json',
          },
        };

        const res = await fetch(geminiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiPayload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          geminiResult = await res.json();
          break; // Succeeded!
        }

        const errText = await res.text();
        lastError = { status: res.status, details: errText.substring(0, 300) };

        // If error is 503 or 429, continue to next fallback model
        if ([503, 429, 500, 404].includes(res.status)) {
          continue;
        } else {
          break; // Client error like bad payload or invalid key, stop trying
        }
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = { status: err.name === 'AbortError' ? 504 : 500, details: err.message };
        continue;
      }
    }

    if (!geminiResult) {
      return new Response(
        JSON.stringify({
          error: 'Google Gemini API 請求失敗，所有備援模型暫時無法回應',
          lastError,
        }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 9. Extract and validate JSON response
    try {
      const rawText = (geminiResult.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '{}';

      let cleanedText = rawText.trim();
      if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      const firstBrace = cleanedText.indexOf('{');
      const lastBrace = cleanedText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleanedText = cleanedText.slice(firstBrace, lastBrace + 1);
      }

      const parsedData = JSON.parse(cleanedText);

      if (action === 'generate_recipes') {
        if (!Array.isArray(parsedData.recipes) || parsedData.recipes.length !== 5) {
          throw new Error('AI 未產生剛好 5 道料理，請重試。');
        }
        const names = new Set();
        const existing = new Set((Array.isArray(existingRecipeNames) ? existingRecipeNames : []).map(normalizeName));
        const forbidden = [
          ...(Array.isArray(preferences?.allergens) ? preferences.allergens : []),
          ...(Array.isArray(preferences?.dislikedIngredients) ? preferences.dislikedIngredients : []),
        ].map(x => String(x).trim()).filter(Boolean);
        for (const recipe of parsedData.recipes) {
          if (!recipe || typeof recipe.name !== 'string' || !recipe.name.trim() ||
              !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0 ||
              !Array.isArray(recipe.steps) || recipe.steps.length < 2) {
            throw new Error('AI 料理缺少必要資料，請重試。');
          }
          const name = normalizeName(recipe.name);
          if (names.has(name) || existing.has(name)) {
            throw new Error('AI 料理名稱重複，請重試。');
          }
          names.add(name);
          for (const ingredient of recipe.ingredients) {
            if (!ingredient || typeof ingredient.name !== 'string' || !ingredient.name.trim() ||
                !Number.isFinite(Number(ingredient.amount)) || Number(ingredient.amount) <= 0 ||
                !Number.isFinite(Number(ingredient.estimatedKcal)) || Number(ingredient.estimatedKcal) < 0 ||
                !Number.isFinite(Number(ingredient.estimatedCost)) || Number(ingredient.estimatedCost) < 0) {
              throw new Error('AI 食材份量或估算資料不完整，請重試。');
            }
          }
          // Conservative text check. Frontend must ALSO check allergens against
          // canonical ingredient metadata; model-generated allergen tags are not reliable.
          const ingredientText = recipe.ingredients.map(i => i.name).join('、');
          const allergenText = Array.isArray(recipe.allergens) ? recipe.allergens.join('、') : '';
          if (forbidden.some(item => ingredientText.includes(item) || allergenText.includes(item))) {
            throw new Error('AI 料理可能包含忌口或過敏原，已拒絕結果，請重試。');
          }
        }
      }
      return new Response(JSON.stringify(parsedData), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (parseErr) {
      return new Response(
        JSON.stringify({
          error: 'Gemini 回傳內容無法解析為有效 JSON',
          message: parseErr.message,
        }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
  },
};

