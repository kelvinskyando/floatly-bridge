/**
 * Floatly × Evolution API webhook receiver
 * ─────────────────────────────────────────
 * Listens for messages from your Evolution API instance, filters to your
 * agent group, parses orders (regex first, Claude fallback), writes to
 * Supabase `orders` table.
 *
 * Deploy: Railway, Render, Fly.io, or any Node host.
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  → from your Supabase project
 *   ANTHROPIC_API_KEY                   → for Claude fallback parsing
 *   GROUP_JID                           → e.g. "1203630xxxxx@g.us"
 *   EVOLUTION_WEBHOOK_TOKEN             → any random string, set same in Evolution
 *   PORT                                → optional, defaults 3000
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── Required env vars (fail fast with a clear message) ──────────
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GROUP_JID', 'EVOLUTION_WEBHOOK_TOKEN'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  console.error('   Set these in Railway → Variables, then redeploy.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 0 } },
    // Server-side: we only do inserts; no realtime/auth needed
    global: { headers: { 'x-client-info': 'floatly-evolution-bridge' } }
  }
);

// Claude fallback is OPTIONAL — runs only if ANTHROPIC_API_KEY is set
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('✓ Claude fallback parser enabled');
  } catch (e) {
    console.warn('⚠ Anthropic SDK not installed — running regex-only');
  }
} else {
  console.log('ℹ ANTHROPIC_API_KEY not set — running regex-only (fine for testing)');
}

const GROUP_JID = process.env.GROUP_JID;
const WEBHOOK_TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN;

// ─── Networks Floatly recognises ───────────────────────────────────
const NETWORK_ALIASES = {
  'mpesa': 'M-Pesa', 'm-pesa': 'M-Pesa', 'm pesa': 'M-Pesa', 'mp': 'M-Pesa',
  'tigopesa': 'Mixx by Yas', 'tigo pesa': 'Mixx by Yas', 'tigo': 'Mixx by Yas',
  'mixx': 'Mixx by Yas', 'mixx by yas': 'Mixx by Yas', 'yas': 'Mixx by Yas',
  'airtel': 'Airtel Money', 'airtel money': 'Airtel Money', 'am': 'Airtel Money',
  'halotel': 'HaloPesa', 'halopesa': 'HaloPesa', 'halo': 'HaloPesa', 'hp': 'HaloPesa',
  'azampesa': 'AzamPesa', 'azam': 'AzamPesa', 'ap': 'AzamPesa',
  'crdb': 'CRDB', 'nmb': 'NMB', 'nbc': 'NBC', 'tcb': 'TCB',
  'selcom': 'SELCOM', 'maendeleo': 'Maendeleo',
  'cash': 'Cash', 'pesa taslimu': 'Cash', 'taslim': 'Cash'
};

const normaliseNetwork = (raw) => {
  if (!raw) return null;
  const k = raw.toLowerCase().trim();
  return NETWORK_ALIASES[k] || (Object.entries(NETWORK_ALIASES).find(
    ([alias]) => k.includes(alias))?.[1] ?? null);
};

// ─── Regex parser (fast path) ─────────────────────────────────────
// Handles common Tanzanian patterns:
//   "naomba 500000 mpesa kwenda tigo"
//   "buy 1m airtel"
//   "tigo to mpesa 200k"
//   "Mpesa 300,000 -> CRDB"
function parseWithRegex(text) {
  const t = text.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();

  // Amount: 200000, 200k, 1.5m, 1m, 500000/=
  let amount = null;
  const mAmt = t.match(/(\d+(?:\.\d+)?)\s*(k|m|elfu|milioni)?/i);
  if (mAmt) {
    let n = parseFloat(mAmt[1]);
    const unit = (mAmt[2] || '').toLowerCase();
    if (unit === 'k' || unit === 'elfu') n *= 1000;
    else if (unit === 'm' || unit === 'milioni') n *= 1_000_000;
    if (n >= 1000 && n <= 50_000_000) amount = n;
  }

  // Networks: pick the first two known-network hits
  const found = [];
  for (const alias of Object.keys(NETWORK_ALIASES)) {
    if (t.includes(alias)) {
      const canonical = NETWORK_ALIASES[alias];
      if (!found.find(f => f.canonical === canonical)) {
        found.push({ alias, canonical, idx: t.indexOf(alias) });
      }
    }
  }
  found.sort((a, b) => a.idx - b.idx);

  // Direction hints (kwenda, to, ->, =>, kutoka)
  const hasDirection = /(kwenda|->|=>|to\s|kutoka|from\s)/.test(t);

  if (amount && found.length >= 2 && hasDirection) {
    return {
      amount,
      from_network: found[0].canonical,
      to_network: found[1].canonical,
      type: 'exchange',
      confidence: 'high',
      method: 'regex'
    };
  }
  if (amount && found.length === 1) {
    return {
      amount,
      from_network: found[0].canonical,
      to_network: null,
      type: /buy|nunua|naomba/.test(t) ? 'buy' : 'sell',
      confidence: 'medium',
      method: 'regex'
    };
  }
  return null; // fall through to Claude
}

// ─── Claude fallback parser (only runs if anthropic client exists) ──
async function parseWithClaude(text) {
  if (!anthropic) return null; // Skip silently when key not configured

  const prompt = `You are parsing a mobile-money float exchange order from a Tanzanian agents WhatsApp group. Messages may be in English or Swahili (or mixed). Extract structured data.

Networks recognised: M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, AzamPesa, CRDB, NMB, NBC, TCB, SELCOM, Maendeleo, Cash.

Message: "${text}"

Respond with ONLY a JSON object, no markdown, no preamble:
{
  "is_order": true|false,
  "type": "exchange"|"buy"|"sell"|null,
  "amount": number|null,
  "from_network": "<canonical name>"|null,
  "to_network": "<canonical name>"|null,
  "notes": "<short note>"|null,
  "confidence": "high"|"medium"|"low"
}

Rules:
- If the message is clearly NOT an order (greeting, joke, question), set is_order=false.
- Amount must be the TZS figure as a plain number (200k → 200000, 1.5m → 1500000).
- Use exact canonical network names from the list above.
- For "exchange", from_network is the source, to_network is the destination.`;

  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    const txt = res.content[0].text.trim().replace(/```json|```/g, '');
    const parsed = JSON.parse(txt);
    if (!parsed.is_order) return null;
    return { ...parsed, method: 'claude' };
  } catch (e) {
    console.error('Claude parse failed:', e.message);
    return null;
  }
}

// ─── Agent lookup ─────────────────────────────────────────────────
async function findAgentByPhone(phone) {
  // Evolution returns JIDs like "255712345678@s.whatsapp.net"
  const cleaned = phone.replace(/[^0-9]/g, '');
  const { data } = await supabase
    .from('agents')
    .select('id, name, phone')
    .or(`phone.eq.${cleaned},phone.eq.+${cleaned},phone.eq.0${cleaned.slice(3)}`)
    .limit(1)
    .maybeSingle();
  return data;
}

// ─── Image upload to Supabase Storage ──────────────────────────────
// Evolution provides the image in one of two ways:
//   1. Inline base64 in `data.message.base64` (when base64=true in webhook config)
//   2. As a media file fetchable via Evolution's /chat/getBase64FromMediaMessage endpoint
// We try the inline path first (cheapest), then fetch as fallback.
async function uploadImage(data, imageMsg, senderPhone) {
  let base64Data = data.message?.base64 || null;

  // Fallback: fetch from Evolution if not inline
  if (!base64Data && process.env.EVOLUTION_BASE_URL && process.env.EVOLUTION_API_KEY) {
    try {
      const url = `${process.env.EVOLUTION_BASE_URL.replace(/\/$/, '')}` +
                  `/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE || 'floatly'}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': process.env.EVOLUTION_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: { key: data.key } })
      });
      const j = await r.json();
      base64Data = j.base64 || null;
    } catch (e) {
      console.warn('Evolution media fetch failed:', e.message);
    }
  }

  if (!base64Data) {
    console.warn('No image data available to upload');
    return null;
  }

  // Strip optional data URL prefix
  const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  // Sanity check: refuse anything > 8 MB
  if (buffer.length > 8 * 1024 * 1024) {
    console.warn(`Image too large (${buffer.length} bytes), skipping`);
    return null;
  }

  // Determine extension from mimetype, fallback to .jpg
  const mime = imageMsg.mimetype || 'image/jpeg';
  const ext = mime.split('/')[1]?.split(';')[0] || 'jpg';
  const filename = `${senderPhone}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { data: up, error } = await supabase.storage
    .from('order-proofs')
    .upload(filename, buffer, {
      contentType: mime,
      cacheControl: '3600',
      upsert: false
    });
  if (error) throw error;

  // Get the public URL
  const { data: { publicUrl } } = supabase.storage
    .from('order-proofs')
    .getPublicUrl(up.path);

  return publicUrl;
}

// ─── Webhook endpoint ─────────────────────────────────────────────
app.post('/webhook/evolution', async (req, res) => {
  // Token check (set webhookByEvents in Evolution to include this)
  if (req.headers['x-webhook-token'] !== WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  // ACK immediately so Evolution doesn't retry
  res.status(200).json({ received: true });

  try {
    const event = req.body.event || req.body.eventName;
    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') return;

    const data = req.body.data;
    const remoteJid = data?.key?.remoteJid;

    // Only process the configured group
    if (remoteJid !== GROUP_JID) return;
    if (data.key.fromMe) return; // skip our own messages

    // ─── Extract message content (text OR image with caption) ─────
    // WhatsApp image messages put the order text in `caption`, and
    // the image bytes in `imageMessage`. We treat the caption as the
    // order text and (in Phase 1) just store the image alongside.
    const m = data.message || {};
    const imageMsg = m.imageMessage;
    const isImage = !!imageMsg;

    const text = isImage
      ? (imageMsg.caption || '')
      : (m.conversation || m.extendedTextMessage?.text || '');

    if (!text || text.length < 3) {
      if (isImage) console.log('Image with no caption — skipped');
      return;
    }

    const senderJid = data.key.participant || remoteJid;
    const senderPhone = senderJid.split('@')[0];
    const senderName = data.pushName || 'Unknown';

    // Parse: regex first, Claude on fallback
    let parsed = parseWithRegex(text);
    if (!parsed) parsed = await parseWithClaude(text);
    if (!parsed) {
      console.log('Not an order:', text.slice(0, 80));
      return;
    }

    // ─── Upload image to Supabase Storage (if present) ────────────
    let imageUrl = null;
    if (isImage) {
      try {
        imageUrl = await uploadImage(data, imageMsg, senderPhone);
      } catch (e) {
        console.error('Image upload failed (saving order anyway):', e.message);
      }
    }

    // Match agent (optional — order still saved if no match)
    const agent = await findAgentByPhone(senderPhone);

    const orderRow = {
      agent_name: agent?.name || senderName,
      agent_phone: senderPhone,
      type: parsed.type,
      from_network: parsed.from_network,
      to_network: parsed.to_network,
      amount: parsed.amount,
      raw_message: text,
      source: 'whatsapp_group',
      status: 'pending',
      parsed_confidence: parsed.confidence,
      image_url: imageUrl,
      image_caption: isImage ? text : null,
      notes: parsed.notes ||
        (agent ? null : `Unregistered phone: ${senderPhone}`)
    };

    const { error } = await supabase.from('orders').insert(orderRow);
    if (error) {
      console.error('Supabase insert failed:', error);
    } else {
      console.log(
        `✓ Order saved [${parsed.method}/${parsed.confidence}]${imageUrl ? ' 📎' : ''}: ` +
        `${parsed.amount} ${parsed.from_network || ''}→${parsed.to_network || ''} ` +
        `from ${senderName}`
      );
    }
  } catch (err) {
    console.error('Handler error:', err);
  }
});

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'floatly-evolution-bridge' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));

