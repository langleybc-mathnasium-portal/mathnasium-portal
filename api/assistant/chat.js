// POST /api/assistant/chat
//
// Backend for the OwnerAssistant widget. Calls Google Gemini with tool
// use, executes tools server-side, and writes the assistant's reply
// (plus any tool-call records) into the owner's Firestore message log
// so the widget's onSnapshot subscription updates in real time.
//
// Auth: Firebase ID token in Authorization: Bearer. Caller MUST be an
// approved user with role === 'owner'. Everyone else gets 403.
//
// Body:
//   { message: string, centerId?: string }
//
// Response: 200 { ok: true } — actual content is written to Firestore.
//
// Env vars (set in Vercel project settings):
//   GEMINI_API_KEY            - from https://aistudio.google.com/app/apikey (free)
//   FIREBASE_SERVICE_ACCOUNT  - already used by other API routes
//   RESEND_API_KEY, RESEND_FROM - already used by /api/send-email
//
// Why Gemini (and not Claude / OpenAI):
//   Google AI Studio gives a real free tier (1,500 req/day on Flash) that
//   covers owner-scale traffic comfortably. Quality is plenty for chat,
//   data lookups, and email drafting. If you ever want to upgrade, swap
//   GEMINI_URL + the request-shape mapper for an Anthropic/OpenAI client
//   and leave everything else (widget, Firestore, tools) untouched.
//
// Notes:
//   - Plain fetch() against the Gemini REST API — no SDK dependency.
//   - Memory model: short-term = last N messages from Firestore;
//     long-term = a free-text "summary" field on /ownerAssistant/{uid}
//     that the model can update via the save_long_term_memory tool.
//   - Tool loop is bounded (MAX_TOOL_TURNS) so a runaway model can't
//     burn an entire serverless budget.

import { getFirestore, authenticateRequest } from '../_lib/firebase-admin.js';
import { runTool, TOOL_DEFINITIONS } from './_tools.js';
import { centreToday } from '../_lib/centreDate.js';

const MODEL          = 'gemini-2.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const HISTORY_LIMIT  = 30;     // messages of context to feed the model
const MAX_TOOL_TURNS = 6;      // hard ceiling on tool-call iterations
const MAX_TOKENS     = 1024;

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/**
 * Convert Firestore message docs to Gemini's `contents` shape.
 * Gemini uses role: 'user' | 'model' (note: 'model', not 'assistant')
 * and wraps content in a `parts` array. We drop UI-only tool-trace
 * docs because they're not part of the model's conversation history.
 */
function toGeminiContents(docs) {
  return docs
    .filter((d) => d.role === 'user' || d.role === 'assistant')
    .map((d) => ({
      role: d.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(d.content || '') }],
    }));
}

/**
 * Translate our shared TOOL_DEFINITIONS (Claude-style `input_schema`)
 * into Gemini's `functionDeclarations` (uses `parameters` instead and
 * accepts a narrower JSON-Schema subset).
 */
function toGeminiTools(defs) {
  return [{
    functionDeclarations: defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: sanitizeSchema(d.input_schema),
    })),
  }];
}

/**
 * Strip fields Gemini's schema parser doesn't understand. It's stricter
 * than Claude's — extra props can cause a 400. We keep type / properties
 * / required / description / enum / items, which covers everything our
 * tools actually use.
 */
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = sanitizeSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = sanitizeSchema(v);
    }
  }
  if (schema.required) out.required = schema.required;
  return out;
}

function systemPrompt({ profile, centerName, summary, today }) {
  const name = profile?.displayName || 'the owner';
  const center = centerName || 'their Mathnasium center';
  const summaryBlock = summary
    ? `\nWhat you know about them from prior conversations:\n${summary}\n`
    : '';
  return `You are Ratio Assistant — a warm, sharp, slightly witty personal AI for ${name}, the owner of ${center}. Think Jarvis: confident, capable, never sycophantic, never robotic.

Today is ${today}.

You can help with anything an owner needs: drafting and sending emails, looking up center data (staff, shifts, announcements), thinking through decisions, or just a quick conversation. Read the tone of the owner's message and match it — if they sound stressed, be calming and efficient; if they're casual, be casual back; if they're focused, be brief.

You can also handle scheduling end-to-end:
- **Bulk auto-scheduling**: use generate_schedule for "schedule next week", "fill in June 16", "auto-schedule July", etc.
- **Single shift**: use add_shift when the owner asks to put one specific person on one specific shift ("schedule Rahul Parmar June 4 3pm-7pm as a host"). Always confirm the user's name, date, time, and role back in plain English after.
- **Listing shifts**: use list_shifts to check what's on the schedule before deleting anything, or when the owner asks "what's on Friday".
- **Deleting**: use delete_shifts when the owner says "delete the drafts", "clear next week's schedule", etc. By default it only touches DRAFT shifts — published shifts are protected unless the owner explicitly says "delete published shifts" or similar. When the request is ambiguous (e.g., "delete the schedule"), ask whether they mean drafts only or everything before running. For bulk deletions (more than ~20 shifts), confirm the count with the owner before executing.

All new shifts — from generate_schedule and add_shift — land as DRAFTS. Instructors don't see drafts; the owner publishes from the Admin weekly grid. If the owner is vague about timing, ask once for a specific date / week / month before running it — never guess and write to the database.

When you take an action via a tool, briefly confirm what you did in plain language. Don't narrate every internal step.

If you learn a durable fact about them (a preference, a recurring person, a long-running project), save it with save_long_term_memory so future-you remembers.
${summaryBlock}
Keep replies short unless the request actually needs depth.`;
}

async function callGemini({ apiKey, system, contents, tools }) {
  const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools,
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  // Auth — owner only.
  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const profile = session.profile;
  if (!profile?.approved) return res.status(403).json({ error: 'Account not approved' });
  // Owner-equivalent roles can use the assistant. Plain admins, instructors,
  // and super-admins are excluded — super-admins use their own surfaces, and
  // the assistant is intentionally scoped to per-centre owner/AA workflow.
  if (profile.role !== 'owner' && profile.role !== 'admin_assistant') {
    return res.status(403).json({ error: 'Owners only' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const userMessage = String(body?.message || '').trim();
  if (!userMessage) return res.status(400).json({ error: 'message required' });

  const db = getFirestore();
  const ownerUid = profile.uid || profile.id;
  const messagesRef = db.collection('ownerAssistant').doc(ownerUid).collection('messages');
  const rootRef     = db.collection('ownerAssistant').doc(ownerUid);

  // Pull recent history (the widget already wrote the new user message
  // into Firestore optimistically, so it's part of `recent`).
  const histSnap = await messagesRef.orderBy('createdAt', 'desc').limit(HISTORY_LIMIT).get();
  const recent = histSnap.docs.map((d) => d.data()).reverse();

  // Load long-term memory + a friendly centre name for the system prompt.
  const rootSnap = await rootRef.get();
  const summary  = rootSnap.exists ? (rootSnap.data().summary || '') : '';

  let centerName = body?.centerId || null;
  if (body?.centerId) {
    try {
      const cSnap = await db.collection('centers').doc(body.centerId).get();
      if (cSnap.exists) centerName = cSnap.data()?.name || body.centerId;
    } catch { /* non-fatal */ }
  }

  const system = systemPrompt({
    profile,
    centerName,
    summary,
    // The centre's date, not the Lambda's — see api/_lib/centreDate.js.
    today: centreToday(),
  });

  // Gemini requires the first turn to be from 'user'. The Firestore log
  // always starts with one (the widget writes the user message before
  // calling us), but guard anyway.
  let contents = toGeminiContents(recent);
  if (contents.length === 0 || contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: userMessage }] });
  }

  const tools = toGeminiTools(TOOL_DEFINITIONS);

  // Tool loop. Each turn either ends (no functionCall parts in the
  // model's reply) or runs tools and feeds functionResponse parts back.
  // Bounded by MAX_TOOL_TURNS so a misbehaving model can't loop forever.
  let finalText = '';
  const toolTrace = [];
  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const resp = await callGemini({ apiKey, system, contents, tools });

      const candidate = resp?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      if (parts.length === 0) {
        finalText = '(no response)';
        break;
      }

      // Echo the model turn back into contents so the next iteration
      // sees its own function calls (Gemini requires this for the
      // functionResponse to match up).
      contents.push({ role: 'model', parts });

      const functionCalls = parts.filter((p) => p.functionCall);
      if (functionCalls.length === 0) {
        finalText = parts
          .filter((p) => typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
          .trim();
        break;
      }

      // Run every requested tool, then collect functionResponse parts.
      const responseParts = [];
      for (const p of functionCalls) {
        const fc = p.functionCall;
        let out;
        try {
          out = await runTool(fc.name, fc.args || {}, {
            profile,
            centerId: body?.centerId || null,
            db,
            ownerUid,
          });
        } catch (err) {
          out = { error: err?.message || 'tool failed' };
        }
        toolTrace.push({ name: fc.name, input: fc.args, output: out });
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result: out },
          },
        });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
  } catch (err) {
    finalText = `I hit an error reaching the model: ${err?.message || err}`;
  }

  if (!finalText) finalText = '(no response)';

  // Persist tool trace records first (UI-only, render as tiny italic
  // lines), then the assistant reply itself. Doing it in this order
  // means the user sees the action acknowledged before the prose reply.
  for (const t of toolTrace) {
    await messagesRef.add({
      role: 'tool',
      toolName: t.name,
      content: summarizeToolResult(t.name, t.output),
      createdAt: new Date(),
    });
  }
  await messagesRef.add({
    role: 'assistant',
    content: finalText,
    createdAt: new Date(),
  });

  return res.status(200).json({ ok: true });
}

function summarizeToolResult(name, output) {
  if (!output) return '';
  if (output.error) return `error: ${output.error}`;
  switch (name) {
    case 'send_email':
      return `sent email to ${output.to || ''}`;
    case 'get_center_data':
      return `looked up ${output.kind || 'data'}`;
    case 'schedule_event':
      return `scheduled ${output.title || 'event'}`;
    case 'generate_schedule': {
      const w = output.window || {};
      const win = w.startDate === w.endDate ? w.startDate : `${w.startDate} → ${w.endDate}`;
      return `generated ${output.shiftsWritten || 0} draft shift${output.shiftsWritten === 1 ? '' : 's'} across ${output.daysGenerated || 0} day${output.daysGenerated === 1 ? '' : 's'}${win ? ` (${win})` : ''}`;
    }
    case 'add_shift':
      return `scheduled ${output.userName || ''} · ${output.date || ''} ${output.startTime || ''}–${output.endTime || ''} · ${output.role || ''}`;
    case 'list_shifts':
      return `found ${output.count || 0} shift${output.count === 1 ? '' : 's'}`;
    case 'delete_shifts':
      return `deleted ${output.deleted || 0} ${output.statusFilter || ''} shift${output.deleted === 1 ? '' : 's'}`;
    case 'save_long_term_memory':
      return 'updated memory';
    default:
      return '';
  }
}
