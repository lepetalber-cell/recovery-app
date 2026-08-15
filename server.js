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

app.disable('etag');
app.use(express.json());
app.use(express.static('public'));

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

app.post('/api/analyze', uploadFields, async (req, res) => {
  try {
    console.log('STEP1: body received');
    const { hrv, hr, sleep, exercise, fatigue, drinking, memo_morning, memo_lunch, memo_dinner } = req.body;
    console.log('STEP2: fields parsed', { hrv, sleep, exercise, drinking });
    const files = req.files || {};
    const mealSummaries = [];

    if (files.food_morning?.[0]) {
      const f = files.food_morning[0];
      mealSummaries.push({ label: '朝食', summary: await analyzeMealImage(f.path, f.mimetype, '朝食') });
    } else if (memo_morning) {
      mealSummaries.push({ label: '朝食', summary: memo_morning });
    }

    if (files.food_lunch?.[0]) {
      const f = files.food_lunch[0];
      mealSummaries.push({ label: '昼食', summary: await analyzeMealImage(f.path, f.mimetype, '昼食') });
    } else if (memo_lunch) {
      mealSummaries.push({ label: '昼食', summary: memo_lunch });
    }

    if (files.food_dinner?.[0]) {
      const f = files.food_dinner[0];
      mealSummaries.push({ label: '夕食', summary: await analyzeMealImage(f.path, f.mimetype, '夕食') });
    } else if (memo_dinner) {
      mealSummaries.push({ label: '夕食', summary: memo_dinner });
    }

    const mealText = mealSummaries.length
      ? mealSummaries.map(m => `${m.label}：${m.summary}`).join('\n')
      : '記録なし';

    console.log('STEP3: calling Claude API, mealText length:', mealText.length);
    const adviceRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `あなたは50代男性専門のリカバリーコーチです。以下のデータを元に、今日の体の状態への具体的なアドバイスを日本語で書いてください。

【体の状態】
HRV: ${hrv || '未計測'}
心拍数: ${hr || '未計測'}
睡眠時間: ${sleep || '未入力'}時間
運動: ${exercise || 'なし'}
だるさ: ${fatigue || 'なし'}
飲酒: ${drinking || 'なし'}

【今日の食事】
${mealText}

アドバイスは3〜4文で、食事とHRVの関係にも触れてください。前向きで具体的な内容にしてください。

アドバイスの後、必ず最後の行に以下の形式だけで出力してください（説明不要）:
FOOD_SCORE:{"ai":抗炎症スコア,"gut":腸活スコア}`
      }]
    });

    console.log('STEP4: Claude API responded');
    const fullText = adviceRes.content[0].text;
    console.log('STEP5: fullText length:', fullText.length);
    const scoreMatch = fullText.match(/FOOD_SCORE:\s*\{\s*"ai"\s*:\s*(\d+)\s*,\s*"gut"\s*:\s*(\d+)\s*\}/);
    let score = null;
    if (scoreMatch) {
      const ai = parseInt(scoreMatch[1]);
      const gut = parseInt(scoreMatch[2]);
      score = { ai, gut, total: Math.round((ai + gut) / 2) };
    }
    const advice = fullText.replace(/\n*FOOD_SCORE:[\s\S]*$/, '').trim();
    console.log('advice length:', advice.length, 'score:', score);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(Buffer.from(JSON.stringify({ meals: mealSummaries, advice, score }), 'utf8'));

  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message, stack: (err.stack || '').split('\n').slice(0,4).join(' | ') }));
    } catch(e2) { console.error('send failed:', e2.message); }
  }
});

app.post('/api/weekly-report', async (req, res) => {
  try {
    const { records } = req.body;
    if (!records || !records.length) return res.status(400).json({ error: 'データがありません' });

    const dataText = records.map(r =>
      `${r.dateStr}: HRV ${r.hrv || '未計測'}, 睡眠 ${r.sleep || '?'}時間, 運動 ${r.exercise || 'なし'}${r.score ? `, 食事スコア ${r.score}点` : ''}`
    ).join('\n');

    const reportRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `あなたは50代男性（断酒中・毎日サーフィン）のリカバリーデータをもとに、note記事の下書きを作成するライターです。

【今週のデータ】
${dataText}

以下の構成でnote記事の下書きを書いてください：

■ タイトル案（3つ）

■ 本文（600字程度）
- 今週のHRVの傾向
- 食事と体の状態の気づき
- 来週へのメッセージ

読者は40〜60代男性で、健康に関心があるが難しい話は苦手。データを「自分ごと」として読める、温かく等身大のトーンで書いてください。`
      }]
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(Buffer.from(JSON.stringify({ report: reportRes.content[0].text }), 'utf8'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AIリカバリーコーチ起動中 → http://localhost:${PORT}`);
});
