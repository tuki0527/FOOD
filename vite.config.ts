import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, Plugin} from 'vite';

// Development Proxy Plugin for AI Studio Environment
function geminiDevProxyPlugin(): Plugin {
  return {
    name: 'gemini-dev-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const isProxyReq = (req.url === '/FOOD/api/gemini-proxy' || req.url === '/api/gemini-proxy');
        if (!isProxyReq) {
          return next();
        }

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        const apiKey = process.env.GEMINI_API_KEY;

        if (req.method === 'GET') {
          res.statusCode = 200;
          res.end(JSON.stringify({
            ok: true,
            status: 'online',
            service: 'AI Studio Dev Proxy',
            hasApiKey: Boolean(apiKey),
            message: apiKey ? 'AI Studio 本機代理連線正常，GEMINI_API_KEY 已配置！' : '環境中尚未配置 GEMINI_API_KEY。'
          }));
          return;
        }

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: 'Method not allowed.' }));
          return;
        }

        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: '環境中尚未提供 GEMINI_API_KEY 金鑰。' }));
          return;
        }

        let bodyStr = '';
        req.on('data', chunk => {
          bodyStr += chunk;
        });

        req.on('end', async () => {
          try {
            const data = JSON.parse(bodyStr || '{}');
            const { action, preferences, availableRecipes, dates, currentDishId, targetDate, existingRecipeNames } = data;

            if (action === 'ping') {
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, status: 'connected', message: 'AI Studio 本機代理連線正常，GEMINI_API_KEY 已配置！' }));
              return;
            }

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

請嚴格輸出純 JSON：
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

            const callModel = async (modelName: string) => {
              const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
              const geminiPayload = {
                contents: [{ role: 'user', parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }] }],
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
              });
            };

            let geminiResp = await callModel('gemini-3.8-flash');
            if (!geminiResp.ok && (geminiResp.status === 404 || geminiResp.status === 400)) {
              geminiResp = await callModel('gemini-flash-latest');
            }

            if (!geminiResp.ok) {
              const errText = await geminiResp.text();
              res.statusCode = 502;
              res.end(JSON.stringify({ ok: false, error: `Gemini API 錯誤 (HTTP ${geminiResp.status}): ${errText.substring(0, 150)}` }));
              return;
            }

            const geminiResult = await geminiResp.json();
            const rawText = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: 'Gemini 未回傳合法的 JSON 物件。' }));
              return;
            }

            const parsed = JSON.parse(match[0]);
            parsed.ok = true;
            res.statusCode = 200;
            res.end(JSON.stringify(parsed));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: err.message || '本機代理處理異常' }));
          }
        });
      });
    },
  };
}

export default defineConfig(() => {
  return {
    base: '/FOOD/',
    plugins: [react(), tailwindcss(), geminiDevProxyPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
