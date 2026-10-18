/**
 * Cloudflare Worker for AI Weekly Meal Planner (AI 個人化每週料理規劃)
 * Secure proxy to Google Gemini API
 * 
 * Features:
 * - CORS preflight and request handling
 * - Method & Payload validation (<20KB)
 * - Safe API Key reading from Cloudflare Worker Secrets (env.GEMINI_API_KEY)
 * - Timeout guard (20s) with AbortController
 * - System prompts enforcing recipe ID validation and pure JSON responses
 * - Action support: ping, generate_week, replace_day
 * - Robust JSON extraction from LLM response (markdown-safe)
 * - Error isolation preventing sensitive credential leaks
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Allow GET / for quick healthcheck in browser
    if (request.method === 'GET') {
      const hasKey = Boolean(env.GEMINI_API_KEY);
      return new Response(
        JSON.stringify({
          ok: true,
          status: 'online',
          service: 'AI Meal Planner Cloudflare Worker Proxy',
          hasApiKey: hasKey,
          message: hasKey
            ? 'Cloudflare Worker 代理運行正常，GEMINI_API_KEY 已配置！'
            : 'Cloudflare Worker 運行中，但尚未設定 GEMINI_API_KEY Secret。請至 Worker Settings > Variables and Secrets 建立。',
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 2. Enforce POST method for API actions
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Method not allowed. Only POST is accepted.' }),
        { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 3. Payload size limit (protect against abuse)
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 25000) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Payload too large. Maximum size is 25KB.' }),
        { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 4. Verify API Key is provisioned in Cloudflare Secrets
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Cloudflare Worker 尚未設定 GEMINI_API_KEY Secret。請先至 Cloudflare 後台 (Settings > Variables and Secrets) 綁定 API 金鑰。',
          code: 'MISSING_API_KEY',
        }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 5. Parse and validate JSON input
    let requestData;
    try {
      requestData = await request.json();
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Invalid JSON payload. 請確認送出之資料為有效 JSON 格式。' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    const { action, preferences, availableRecipes, dates, currentDishId, targetDate, existingRecipeNames } = requestData;

    // Handle Ping Action for Connection Test
    if (action === 'ping') {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 'connected',
          message: 'Cloudflare Worker 代理運行正常，GEMINI_API_KEY 已成功配置！',
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    if (!action || !['generate_week', 'replace_day', 'generate_recipes'].includes(action)) {
      return new Response(
        JSON.stringify({ ok: false, error: '無效的 action 操作。支援：ping, generate_week, replace_day, generate_recipes。' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 6. Build the specialized prompt for Gemini
    let systemInstruction = `你是一位專業的個人化營養與每週料理規劃師。
重要規則：
1. 你必須【只能】從給定的候選料理清單中挑選 recipeId，絕對不可自行捏造不存在的料理或食材 ID！
2. 絕對不可推薦包含使用者忌口或過敏原 (allergens) 的料理。
3. 兼顧蛋白質來源多樣性（雞肉、豬肉、海鮮、豆腐、蛋類）與食材共用原則，降低每週超市採買包裝成本。
4. 嚴格輸出合法的純 JSON 格式，不得包含任何額外說明文字或對話。`;

    let userPrompt = '';

    if (action === 'generate_week') {
      userPrompt = `請為以下偏好規劃 7 天晚餐（固定一人份）：
- 使用者飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 喜愛食材：${(preferences?.likedIngredients || []).join(', ') || '無特別指定'}
- 討厭食材：${(preferences?.dislikedIngredients || []).join(', ') || '無'}
- 過敏與絕對排除：${(preferences?.allergens || []).join(', ') || '無'}
- 偏好料理類型：${preferences?.cuisineStyle || '綜合家常'}
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
    } else if (action === 'replace_day') {
      userPrompt = `使用者想要替換 ${targetDate} 的晚餐料理（原料理 ID: ${currentDishId}）。
- 使用者飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 喜愛食材：${(preferences?.likedIngredients || []).join(', ') || '無特別指定'}
- 討厭食材：${(preferences?.dislikedIngredients || []).join(', ') || '無'}
- 過敏與絕對排除：${(preferences?.allergens || []).join(', ') || '無'}
- 偏好料理類型：${preferences?.cuisineStyle || '無'}

候選料理清單：
${JSON.stringify(availableRecipes, null, 1)}

請從中挑選 2 到 3 道最適合的替代料理（不要選原料理 ID），直接輸出純 JSON 格式：
{
  "mode": "ai",
  "candidates": [
    {
      "recipeId": "rec_xxx",
      "reason": "具體說明替換優點，例如低卡清爽或共用本週現有食材（20字以內繁體中文）"
    }
  ]
}`;
    } else if (action === 'generate_recipes') {
      systemInstruction = `你是一位資深的台灣家庭料理主廚與營養配膳師。
重要規則：
1. 必須一次創作剛好 3 道【全新且實用】的一人份晚餐料理，絕對不得與現有料理名稱或食材搭配高度相似！
2. 料理風格符合台灣小資生活：食材容易在全聯或常見超市買到，能在 15~25 分鐘內用平底鍋或電鍋完成。
3. 蛋白質來源多樣化（例如：雞肉、豬肉、海鮮魚蝦、豆腐豆製品、雞蛋）。
4. 食材數量必須精準為一人份（例如肉類 120-180g、蔬菜 100-200g、米 80g 等）。
5. 嚴格輸出符合 schema 的合法的純 JSON 格式，不得包含 markdown 標籤或任何對話。`;

      userPrompt = `請為小資族一人份晚餐創作 3 道全新料理食譜。
現有料理庫中已有的料理名稱（【絕對不得重複】以下名稱或類似組合）：
${(existingRecipeNames || []).join('、')}

偏好參考：
- 飲食偏好：${preferences?.dietGoal || '均衡飲食'}
- 偏好料理類型：${preferences?.cuisineStyle || '綜合家常'}
- 絕對避開之過敏原：${(preferences?.allergens || []).join(', ') || '無'}

請嚴格輸出符合以下結構的純 JSON 格式：
{
  "mode": "ai",
  "recipes": [
    {
      "name": "料理名稱（例如：香煎蒜香彩椒雞里肌飯）",
      "category": "料理分類（例如：家常台式、日式定食、健康輕食、暖胃湯煲）",
      "description": "25字以內的簡要特色說明",
      "cookTimeMinutes": 15,
      "primaryProtein": "chicken 或 pork 或 seafood 或 tofu 或 egg",
      "tags": ["高蛋白質", "快速料理", "台味下飯"],
      "allergens": ["大豆"] (若無則為空陣列 []),
      "ingredients": [
        {
          "name": "食材名稱（如：去骨清雞胸肉、彩椒、青蔥、蒜頭、白米）",
          "amount": 150,
          "unit": "g 或 份 或 顆",
          "category": "肉類海鮮 或 蔬菜蕈菇 或 蛋豆製品 或 主食米麵 或 基礎調味",
          "isPantry": false (若為醬油、鹽、油、糖、蒜、薑、黑胡椒等家中常備調味則設為 true),
          "packageSize": 300,
          "packageUnit": "盒 或 包 或 顆",
          "referencePrice": 89,
          "kcal": 170
        }
      ],
      "steps": [
        "步驟一：清洗並備料...",
        "步驟二：熱平底鍋...",
        "步驟三：調味收汁...",
        "步驟四：盛盤享用..."
      ]
    }
  ]
}`;
    }

    // 7. Request to Google Gemini API with 20s timeout and model fallback
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const callGeminiModel = async (modelName) => {
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const geminiPayload = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      };

      return await fetch(geminiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
        signal: controller.signal,
      });
    };

    try {
      let geminiResponse = await callGeminiModel('gemini-3.8-flash');

      // Fallback to gemini-flash-latest if needed
      if (!geminiResponse.ok && (geminiResponse.status === 404 || geminiResponse.status === 400)) {
        geminiResponse = await callGeminiModel('gemini-flash-latest');
      }

      clearTimeout(timeoutId);

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        let errorMsg = `Google Gemini API 回應錯誤 (HTTP ${geminiResponse.status})`;
        try {
          const errObj = JSON.parse(errorText);
          if (errObj.error?.message) {
            errorMsg += `: ${errObj.error.message}`;
          }
        } catch (e) {
          errorMsg += `: ${errorText.substring(0, 150)}`;
        }

        return new Response(
          JSON.stringify({
            ok: false,
            error: errorMsg,
            status: geminiResponse.status,
          }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      const geminiResult = await geminiResponse.json();
      const rawText = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Robust JSON extraction (find outermost { ... })
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Gemini 回傳內容未包含合法的 JSON 物件格式。' }),
          { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      const parsedData = JSON.parse(match[0]);
      parsedData.ok = true;

      return new Response(JSON.stringify(parsedData), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err.name === 'AbortError';
      return new Response(
        JSON.stringify({
          ok: false,
          error: isTimeout ? '請求 Gemini API 超時（超過 20 秒）' : `Worker 代理請求失敗: ${err.message}`,
        }),
        { status: isTimeout ? 504 : 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }
  },
};
