const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ---------- Environment variables (set on Railway) ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROUP_JID = process.env.GROUP_JID;
const WEBHOOK_TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY || !GROUP_JID || !WEBHOOK_TOKEN) {
  console.error('❌ Missing one or more required environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------- Helper: Regex-based order extraction (faster, cheaper) ----------
function parseWithRegex(text) {
  const lower = text.toLowerCase();
  // Look for amounts: 50000, 50k, 50,000, 50.000, hundred thousand, 1m, etc.
  const amountRegex = /(\d+(?:[.,]\d+)?)\s*(k|m|elfu|milioni|thousand|million)?/i;
  const match = text.match(amountRegex);
  if (!match) return null;

  let amount = parseFloat(match[1].replace(',', '.'));
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'elfu' || unit === 'thousand') amount *= 1000;
  else if (unit === 'm' || unit === 'milioni' || unit === 'million') amount *= 1000000;

  // Detect payment method & destination
  let method = null;
  let destination = null;
  if (/(mpesa|m-pesa|vodacom|halopesa|tigo pesa|airtel money)/i.test(text)) method = 'M-Pesa';
  else if (/tigo ?pesa/i.test(text)) method = 'Tigo Pesa';
  else if (/airtel money/i.test(text)) method = 'Airtel Money';
  else method = 'Unknown';

  if (/(kwenda|kwa|to)\s+(tigo|vodacom|airtel|halotel|zantel)/i.test(text)) {
    const matchDest = text.match(/(kwenda|kwa|to)\s+(\w+)/i);
    if (matchDest) destination = matchDest[2];
  }

  return { amount, method, destination };
}

// ---------- Main webhook endpoint (called by Evolution API) ----------
app.post('/webhook/evolution', async (req, res) => {
  // Verify token to prevent unauthorized calls
  const token = req.headers['x-webhook-token'];
  if (token !== WEBHOOK_TOKEN) {
    console.warn('❌ Unauthorized webhook call – wrong token');
    return res.status(401).json({ error: 'Invalid token' });
  }

  const body = req.body;
  // Evolution sends different payload shapes. Handle common ones.
  const messages = body.messages || (body.data && body.data.messages) || [];
  if (!messages.length) {
    return res.status(200).json({ received: true, message: 'No messages in payload' });
  }

  for (const msg of messages) {
    const chatId = msg.key?.remoteJid || msg.remoteJid || msg.from;
    // Only process messages from the target group
    if (chatId !== GROUP_JID) continue;

    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.text;
    if (!text) continue;

    const sender = msg.pushName || msg.notifyName || 'Unknown';
    console.log(`📩 New message from ${sender}: ${text}`);

    // Try regex first (fast path)
    let order = parseWithRegex(text);

    // If regex fails, use Claude (slower but catches complex phrasings)
    if (!order) {
      console.log('🤖 Regex missed, asking Claude...');
      try {
        const claudeResponse = await anthropic.messages.create({
          model: 'claude-3-haiku-20240307',
          max_tokens: 200,
          temperature: 0,
          system: `You are an order parser for a Tanzanian agent. 
                    Extract: amount (as number in TZS), paymentMethod (M-Pesa/Tigo Pesa/Airtel Money/Unknown), destination (optional, e.g., Tigo, Vodacom).
                    Return JSON only: {"amount": number, "paymentMethod": string, "destination": string|null}
                    If no order, return {"amount": null}.`,
          messages: [{ role: 'user', content: text }]
        });
        const jsonMatch = claudeResponse.content[0].text.match(/\{.*\}/s);
        if (jsonMatch) {
          order = JSON.parse(jsonMatch[0]);
          if (order.amount === null) order = null;
        }
      } catch (err) {
        console.error('Claude error:', err.message);
      }
    }

    if (order && order.amount && order.amount > 0) {
      // Save to Supabase
      const { error } = await supabase
        .from('orders')
        .insert({
          amount: order.amount,
          payment_method: order.method || order.paymentMethod,
          destination: order.destination,
          customer_name: sender,
          raw_message: text,
          status: 'pending',
          created_at: new Date().toISOString()
        });
      if (error) {
        console.error('❌ Supabase insert error:', error);
      } else {
        console.log(`✅ Order saved: ${order.amount} TZS via ${order.method || order.paymentMethod} from ${sender}`);
      }
    } else {
      console.log(`⏩ No order detected in message: "${text}"`);
    }
  }

  res.status(200).json({ received: true });
});

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Floatly bridge listening on port ${PORT}`);
});