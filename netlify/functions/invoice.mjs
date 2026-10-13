// יהודה שיפוצים — הפקת מסמכים בחשבונית ירוקה (morning) · v25.6
// ------------------------------------------------------------------
// המפתחות של חשבונית ירוקה נשמרים רק כאן, בשרת של Netlify — לא בטלפון.
//
// הגדרה חד-פעמית ב-Netlify (Site configuration → Environment variables):
//   GI_KEY_ID      = מזהה מפתח ה-API (חשבונית ירוקה: אזור אישי → כלים למפתחים → מפתחות API)
//   GI_KEY_SECRET  = הסוד של אותו מפתח
//   INVOICE_TOKEN  = קוד חיבור שאתה ממציא (לפחות 12 תווים). מקלידים את אותו קוד באפליקציה,
//                    הגדרות → עסק → חשבונית ירוקה. בלי הקוד הנכון הפונקציה לא מפיקה כלום.
//   GI_ENV         = (לא חובה) sandbox — לסביבת הניסיון של חשבונית ירוקה. ריק = אמיתי.
//
// כתובות ה-API ושדות המסמך — לפי ספריית green-invoice 2.0.0 (PyPI):
//   משאבים: https://api.greeninvoice.co.il/api/v1 · ניסיון: https://sandbox.d.greeninvoice.co.il/api/v1
//   טוקן (OAuth client_credentials): https://api.morning.co/idp/v1/oauth/token · ניסיון: https://api.sandbox.morning.dev/idp/v1/oauth/token
//   ואם נכשל — המסלול הישן POST {base}/account/token {id,secret}.
// סוגי מסמכים: 300 חשבון עסקה · 305 חשבונית מס · 320 חשבונית מס קבלה · 400 קבלה.
// אמצעי תשלום: 1 מזומן · 2 צ'ק · 3 אשראי · 4 העברה בנקאית · 10 אפליקציית תשלום (ביט/פייבוקס) · 11 אחר.

const HOSTS = {
  live: { api: 'https://api.greeninvoice.co.il/api/v1', idp: 'https://api.morning.co/idp/v1/oauth/token' },
  sandbox: { api: 'https://sandbox.d.greeninvoice.co.il/api/v1', idp: 'https://api.sandbox.morning.dev/idp/v1/oauth/token' }
};
const TYPES = { 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס קבלה', 400: 'קבלה' };
const PAY = [1, 2, 3, 4, 10, 11];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => { const x = Math.round((+v || 0) * 100) / 100; return isFinite(x) ? x : 0; };
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // תאריך בישראל (בערך)

function same(a, b) { // השוואה בזמן קבוע
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const errText = (j, status) => {
  if (j && typeof j === 'object') return j.error_description || j.errorMessage || j.message || j.description || (j.messages && j.messages.message && (j.messages.message.description || JSON.stringify(j.messages.message).slice(0, 200))) || j.error || ('HTTP ' + status);
  return String(j || 'HTTP ' + status).slice(0, 200);
};

async function readJson(r) { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch (e) { return t; } }

/** טוקן: קודם OAuth, ואם נכשל — המסלול הישן. מחזיר {token, via} או זורק שגיאה עם שני הניסיונות */
export async function getToken(env, f = fetch) {
  const H = HOSTS[env.GI_ENV === 'sandbox' ? 'sandbox' : 'live'];
  const errs = [];
  try {
    const r = await f(H.idp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.GI_KEY_ID, client_secret: env.GI_KEY_SECRET }) });
    const j = await readJson(r);
    if (r.ok && j && j.accessToken) return { token: j.accessToken, via: 'oauth' };
    errs.push('oauth: ' + errText(j, r.status));
  } catch (e) { errs.push('oauth: ' + (e && e.message || e)); }
  try {
    const r = await f(H.api + '/account/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: env.GI_KEY_ID, secret: env.GI_KEY_SECRET }) });
    const j = await readJson(r);
    const tok = (j && j.token) || r.headers.get('x-authorization-bearer');
    if (r.ok && tok) return { token: tok, via: 'legacy' };
    errs.push('legacy: ' + errText(j, r.status));
  } catch (e) { errs.push('legacy: ' + (e && e.message || e)); }
  const err = new Error('ההתחברות לחשבונית ירוקה נכשלה — ' + errs.join(' | '));
  err.code = 'auth'; throw err;
}

/** בונה את גוף המסמך מבקשת האפליקציה — רק שדות מוכרים, עם בדיקות */
export function buildDoc(d) {
  const type = +d.type;
  if (!TYPES[type]) throw Object.assign(new Error('סוג מסמך לא נתמך'), { code: 'input' });
  const name = clean(d.client && d.client.name, 100);
  if (!name) throw Object.assign(new Error('חסר שם לקוח'), { code: 'input' });
  const income = (Array.isArray(d.income) ? d.income : []).slice(0, 200).map(i => ({
    description: clean(i.description, 250) || 'עבודות שיפוץ',
    quantity: num(i.quantity) || 1,
    price: num(i.price),
    currency: 'ILS',
    vatType: +i.vatType === 1 ? 1 : 0 // 0 = מע"מ יתווסף · 1 = המחיר כולל מע"מ
  })).filter(i => i.price > 0 && i.quantity > 0);
  if (type !== 400 && !income.length) throw Object.assign(new Error('אין שורות עם מחיר'), { code: 'input' });
  const doc = {
    description: clean(d.description, 120) || TYPES[type],
    type, lang: 'he', currency: 'ILS', vatType: 0, rounding: false, signed: true,
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : today(),
    client: { name, add: true },
    remarks: clean(d.remarks, 500)
  };
  const c = d.client || {};
  if (clean(c.phone, 30)) doc.client.phone = clean(c.phone, 30);
  if (clean(c.address, 120)) doc.client.address = clean(c.address, 120);
  const em = clean(c.email, 100); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) doc.client.emails = [em];
  if (type !== 400) doc.income = income;
  if (+d.discountPct > 0 && +d.discountPct < 100 && type !== 400) doc.discount = { amount: num(d.discountPct), type: 'percentage' };
  if (type === 320 || type === 400) {
    const amt = num(d.payment && d.payment.amount);
    const pt = +(d.payment && d.payment.type);
    if (!(amt > 0)) throw Object.assign(new Error('חסר סכום תשלום'), { code: 'input' });
    if (PAY.indexOf(pt) < 0) throw Object.assign(new Error('אמצעי תשלום לא נתמך'), { code: 'input' });
    doc.payment = [{ type: pt, price: amt, currency: 'ILS', date: doc.date }];
    if (type === 400) doc.income = undefined;
  }
  if (!doc.remarks) delete doc.remarks;
  return doc;
}

export async function handle(req, env, f = fetch) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.INVOICE_TOKEN || String(env.INVOICE_TOKEN).length < 12) return json({ error: 'INVOICE_TOKEN חסר בהגדרות Netlify (לפחות 12 תווים)', code: 'setup' }, 503);
  if (!env.GI_KEY_ID || !env.GI_KEY_SECRET) return json({ error: 'GI_KEY_ID / GI_KEY_SECRET חסרים בהגדרות Netlify', code: 'setup' }, 503);
  let b;
  try { const t = await req.text(); if (t.length > 200000) return json({ error: 'too large' }, 413); b = JSON.parse(t); } catch (e) { return json({ error: 'bad json' }, 400); }
  if (!same(b.token, env.INVOICE_TOKEN)) return json({ error: 'קוד החיבור שגוי', code: 'token' }, 401);
  try {
    if (b.action === 'ping') {
      const t = await getToken(env, f);
      return json({ ok: true, via: t.via, env: env.GI_ENV === 'sandbox' ? 'sandbox' : 'live' });
    }
    if (b.action === 'create') {
      const doc = buildDoc(b.doc || {});
      const t = await getToken(env, f);
      const H = HOSTS[env.GI_ENV === 'sandbox' ? 'sandbox' : 'live'];
      const r = await f(H.api + '/documents', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token }, body: JSON.stringify(doc) });
      const j = await readJson(r);
      if (!r.ok || !j || !j.id) return json({ error: 'חשבונית ירוקה: ' + errText(j, r.status), code: 'api', status: r.status }, 502);
      const url = (j.url && (j.url.he || j.url.origin || j.url.en)) || '';
      return json({ ok: true, id: j.id, number: j.number, type: doc.type, typeName: TYPES[doc.type], url, env: env.GI_ENV === 'sandbox' ? 'sandbox' : 'live' });
    }
    return json({ error: 'action' }, 400);
  } catch (e) {
    const code = e && e.code || 'error';
    return json({ error: String(e && e.message || e).slice(0, 400), code }, code === 'input' ? 400 : 502);
  }
}

export default async (req) => handle(req, {
  GI_KEY_ID: process.env.GI_KEY_ID, GI_KEY_SECRET: process.env.GI_KEY_SECRET,
  INVOICE_TOKEN: process.env.INVOICE_TOKEN, GI_ENV: process.env.GI_ENV
});

export const config = { path: '/api/invoice' };
