const http = require('node:http');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://exile-character-viewer-next.onrender.com';
const PORT = process.env.PORT || 3000;

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
  if (req.method !== 'POST' || req.url !== '/api/recognize-item') return send(res, 404, { error: 'Not found' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { error: 'На сервере не задан OPENAI_API_KEY. Добавь ключ в Environment на Render.' });

  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_IMAGE_BYTES * 1.5) return send(res, 413, { error: 'Изображение слишком большое. Максимум 8 МБ.' });
    }
    const data = JSON.parse(body || '{}');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data.image || '');
    if (!match) return send(res, 400, { error: 'Не удалось прочитать изображение. Поддерживаются JPEG, PNG и WebP.' });
    const mime = match[1], base64 = match[2];
    if (Buffer.from(base64, 'base64').length > MAX_IMAGE_BYTES) return send(res, 413, { error: 'Изображение больше 8 МБ.' });

    const prompt = `Ты эксперт по предметам Path of Exile 1. Распознай предмет на скриншоте игры.
Верни ТОЛЬКО корректный JSON без markdown, строго с полями:
{
 "isItem": true,
 "rarity": "NORMAL|MAGIC|RARE|UNIQUE",
 "name": "название предмета",
 "baseType": "базовый тип предмета",
 "requiredLevel": number|null,
 "slot": "Helmet|Amulet|Body Armour|Gloves|Boots|Weapon 1|Weapon 2|Ring 1|Ring 2|Belt"|null,
 "mods": ["каждая строка свойства точно как на скриншоте"],
 "rawText": "все распознанные строки предмета"
}
Правила:
- Не выдумывай значения. Если не уверен, сохрани null/пустую строку или пометь сомнительную строку в rawText.
- Отделяй название от базового типа. Пример: Sol Loop / Sapphire Ring.
- Сохраняй все числа, знаки +/-, проценты и диапазоны точно.
- Различай сопротивления огню, холоду, молнии и хаосу.
- Не принимай фоновые элементы, названия интерфейса и требования уровня за модификаторы.
- Для колец укажи slot "Ring 1"; приложение сможет выбрать любое кольцо в любой слот кольца.
- Если на картинке не подсказка одного предмета Path of Exile, isItem=false.
- mods содержит только строки модификаторов, без названия, базы и Requires Level.`;

    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1',
        input: [{ role: 'user', content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: `data:${mime};base64,${base64}`, detail: 'original' }
        ]}],
        text: { format: { type: 'json_object' } },
        max_output_tokens: 1400
      })
    });
    const result = await apiResponse.json();
    if (!apiResponse.ok) {
      const message = result.error?.message || 'OpenAI API request failed';
      return send(res, apiResponse.status, { error: message });
    }
    const output = (result.output || []).flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text || result.output_text;
    if (!output) return send(res, 502, { error: 'Модель не вернула распознанный текст.' });
    const item = JSON.parse(output);
    if (!item.isItem || !item.name || !item.baseType) return send(res, 422, { error: 'На изображении не удалось уверенно определить предмет. Попробуй скриншот подсказки целиком.' });
    return send(res, 200, { item });
  } catch (err) {
    return send(res, 500, { error: err.message || 'Internal server error' });
  }
});
server.listen(PORT, () => console.log('PoE vision API listening on ' + PORT));
