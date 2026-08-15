require('dotenv').config();
const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });
const uploadFields = upload.fields([
  { name: 'food_morning', maxCount: 1 },
  { name: 'food_lunch', maxCount: 1 },
  { name: 'food_dinner', maxCount: 1 }
]);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// 食事写真分析ヘルパー
async function analyzeMealImage(filePath, mimeType, mealName) {
  const imageData = fs.readFileSync(filePath);
  const base64Image = imageData.toString('base64');
  fs.unlinkSync(filePath);

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
        { type: 'text', text: `これは${mealName}の写真です。料理名と栄養の特徴を1〜2文で簡潔に日本語で説明してください。` }
      ]
    }]
  });
  return res.content[0].text;
}

// 食事写真分析 + HRVアドバイス
app.post('/api/analyze', uploadFields, async (req, res) => {
  try {
    const { hrv, hr, sleep, exercise, fatigue, memo_morning, memo_lunch, memo_dinner } = req.body;
    const files = req.files || {};
    const mealSummaries = [];

    // 朝食
    if (files.food_morning?.[0]) {
      const f = files.food_morning[0];
      const summary = await analyzeMealImage(f.path, f.mimetype, '朝食');
      mealSummaries.push({ label: '朝食', summary });
    } else if (memo_morning) {
      mealSummaries.push({ label: '朝食', summary: memo_morning });
    }

    // 昼食
    if (files.food_lunch?.[0]) {
      const f = files.food_lunch[0];
      const summary = await analyzeMealImage(f.path, f.mimetype, '昼食');
      mealSummaries.push({ label: '昼食', summary });
    } else if (memo_lunch) {
      mealSummaries.push({ label: '昼食', summary: memo_lunch });
    }

    // 夕食
    if (files.food_dinner?.[0]) {
      const f = files.food_dinner[0];
      const summary = await analyzeMealImage(f.path, f.mimetype, '夕食');
      mealSummaries.push({ label: '夕食', summary });
    } else if (memo_dinner) {
      mealSummaries.push({ label: '夕食', summary: memo_dinner });
    }

    const mealText = mealSummaries.length
      ? mealSummaries.map(m => `${m.label}：${m.summary}`).join('\n')
      : '記録なし';

    // HRV + 食事データからアドバイス生成
    const adviceRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `あなたは50代男性専門のリカバリーコーチです。以下のデータを元に、今日の体の状態への具体的なアドバイスを日本語で書いてください。

【体の状態】
HRV: ${hrv || '未計測'}
心拍数: ${hr || '未計測'}
睡眠時間: ${sleep || '未入力'}時間
運動: ${exercise || 'なし'}
だるさ: ${fatigue || 'なし'}
メモ: ${memo_morning || ''}

【今日の食事】
${mealText}

アドバイスは3〜4文で、食事とHRVの関係にも触れてください。前向きで具体的な内容にしてください。`
      }]
    });

    res.json({
      meals: mealSummaries,
      advice: adviceRes.content[0].text
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AIリカバリーコーチ起動中 → http://localhost:${PORT}`);
  console.log(`📱 iPhoneからは http://[PCのIPアドレス]:${PORT} でアクセス`);
});
