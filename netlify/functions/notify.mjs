// יהודה שיפוצים — התראות לטלפון (Web Push) · v25.5
// ------------------------------------------------------------------
// מה זה: כשלקוח פותח לינק הצעה או מאשר אותו, דף הלקוח שולח לכאן בקשה,
// והפונקציה שולחת התראה לטלפון של יהודה — גם כשהאפליקציה סגורה.
//
// הגדרה חד-פעמית ב-Netlify (Site configuration → Environment variables):
//   PUSH_SECRET = מחרוזת אקראית ארוכה כלשהי (למשל 30 תווים). לא משנים אותה אחר כך —
//                 שינוי שלה מבטל את ההרשמה להתראות בכל המכשירים (צריך להפעיל מחדש).
//
// בלי ספריות חיצוניות (אין package.json): ההצפנה לפי RFC 8291 (aes128gcm)
// והחתימה לפי RFC 8292 (VAPID, ES256) — עם crypto המובנה של Node.
//
// API:
//   GET  /api/notify?pk=1          → {publicKey}   (המפתח הציבורי להרשמה — נגזר מ-PUSH_SECRET)
//   POST /api/notify  (text/plain JSON) {subs:[subscription...], ev:'view'|'hot'|'approve'|'comment'|'test', cn, no, tot}
//        → {sent, results:[status...]}
// הכותרת והטקסט נבנים כאן — מהבקשה מגיעים רק שם לקוח, מספר הצעה וסכום (מקוצרים ומנוקים).
// שליחה רק לשרתי push מוכרים (Google / Mozilla / Apple / Microsoft).

import crypto from 'node:crypto';

const SUBJECT = 'mailto:yuda090581@gmail.com';
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)android\.googleapis\.com$/];
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'); // סדר העקומה P-256

export const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** מפתח VAPID קבוע שנגזר מהסוד: d = SHA-256("ys-vapid|"+secret) mod (n-1) + 1 */
export function vapidKeys(secret) {
  const h = crypto.createHash('sha256').update('ys-vapid|' + secret).digest();
  let d = BigInt('0x' + h.toString('hex')) % (N - 1n) + 1n;
  const dBuf = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(dBuf);
  const pub = ecdh.getPublicKey(); // 65 bytes, 0x04|X|Y
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u(dBuf), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  return { publicKey: b64u(pub), privateKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }) };
}

/** JWT ל-VAPID (RFC 8292) */
export function vapidAuth(endpoint, keys, now = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: now + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.publicKey;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** הצפנת תוכן ההתראה (RFC 8291, aes128gcm, רשומה אחת). opts.asKey/opts.salt — לבדיקות בלבד */
export function encrypt(payload, sub, opts = {}) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const as = crypto.createECDH('prime256v1');
  if (opts.asKey) as.setPrivateKey(opts.asKey); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const salt = opts.salt || crypto.randomBytes(16);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const money = v => { const x = Math.round(+v || 0); return x > 0 ? x.toLocaleString('he-IL') + ' ₪' : ''; };

/** הכותרת והטקסט — נבנים בשרת בלבד */
export function message(b) {
  const cn = clean(b.cn, 40) || 'לקוח', no = clean(b.no, 30), tot = money(b.tot);
  const tail = [no, tot].filter(Boolean).join(' · ');
  if (b.ev === 'approve') return { title: '✅ ' + cn + ' אישר/ה את ההצעה', body: tail || 'ההצעה אושרה' };
  if (b.ev === 'comment') return { title: '💬 ' + cn + ' השאיר/ה הערה', body: tail || 'יש הערה חדשה בהצעה' };
  if (b.ev === 'hot') { const n = Math.max(3, Math.min(99, Math.round(+b.n || 3))); return { title: '🤔 ' + cn + ' פתח/ה את ההצעה ' + n + ' פעמים', body: (tail ? tail + ' · ' : '') + 'מתלבט/ת — זה הזמן להתקשר' }; }   // v26.6
  if (b.ev === 'test') return { title: '🔔 התראות פועלות', body: 'מעכשיו תקבל התראה כשלקוח פותח או מאשר הצעה' };
  return { title: '👀 ' + cn + ' פתח/ה את ההצעה', body: tail ? tail + ' · זה זמן טוב להתקשר' : 'זה זמן טוב להתקשר' };
}

export function allowedEndpoint(ep) {
  try { const u = new URL(ep); return u.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(u.hostname)); } catch (e) { return false; }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });

export async function handle(req, env, fetchImpl = fetch) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const secret = env.PUSH_SECRET;
  if (!secret) return json({ error: 'PUSH_SECRET חסר בהגדרות Netlify' }, 503);
  const keys = vapidKeys(secret);
  if (req.method === 'GET') return json({ publicKey: keys.publicKey });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let b;
  try { const t = await req.text(); if (t.length > 20000) return json({ error: 'too large' }, 413); b = JSON.parse(t); } catch (e) { return json({ error: 'bad json' }, 400); }
  const subs = (Array.isArray(b.subs) ? b.subs : []).filter(s => s && s.endpoint && s.keys && allowedEndpoint(s.endpoint)).slice(0, 5);
  if (!subs.length) return json({ sent: 0, results: [], error: 'no valid subscription' }, 400);
  const msg = message(b);
  const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: 'ys-' + clean(b.no, 30) + '-' + (b.ev || 'view'), url: './' });
  const results = await Promise.all(subs.map(async s => {
    try {
      const r = await fetchImpl(s.endpoint, {
        method: 'POST',
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidAuth(s.endpoint, keys) },
        body: encrypt(payload, s)
      });
      return r.status;
    } catch (e) { return 0; }
  }));
  return json({ sent: results.filter(x => x >= 200 && x < 300).length, results });
}

export default async (req) => handle(req, { PUSH_SECRET: process.env.PUSH_SECRET });

export const config = { path: '/api/notify' };
