/* Mini Link — QR Maker payload builders (pure logic, no DOM).
   Loaded before public.js; tested in Node with /tmp/test-qr-maker.js.
   Exposes window.QrMaker = { QR_TYPES, MAX_PAYLOAD, escapeWifiValue,
   buildQrPayload }. No network, no storage — just string building. */
'use strict';

(function (global) {
  var QR_TYPES = ['link', 'instagram', 'wifi', 'phone', 'text', 'review'];
  var MAX_PAYLOAD = 2048;

  // Wi-Fi QR spec: escape \ ; , : " with a backslash.
  function escapeWifiValue(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/:/g, '\\:')
      .replace(/"/g, '\\"');
  }

  function isHttpUrl(s) {
    try {
      var u = new URL(String(s).trim());
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch (e) {
      return false;
    }
  }

  // fields: per-type inputs. Returns { ok: true, payload } or
  // { ok: false, reason } (Georgian error for the UI).
  function buildQrPayload(type, f) {
    f = f || {};
    if (type === 'link' || type === 'review') {
      var url = String(f.url || '').trim();
      if (!url) return { ok: false, reason: 'ბმული შეიყვანეთ.' };
      if (!isHttpUrl(url)) return { ok: false, reason: 'ბმული http(s)://-ით უნდა იწყებოდეს.' };
      if (url.length > MAX_PAYLOAD) return { ok: false, reason: 'ბმული ძალიან გრძელია (მაქს. 2048 სიმბოლო).' };
      return { ok: true, payload: url };
    }
    if (type === 'instagram') {
      var handle = String(f.handle || '').trim().replace(/^@/, '');
      if (!handle) return { ok: false, reason: 'Instagram მომხმარებელი შეიყვანეთ.' };
      if (/^https?:\/\//i.test(handle)) {
        if (!isHttpUrl(handle) || !/instagram\.com/i.test(handle)) {
          return { ok: false, reason: 'Instagram ბმული არასწორია.' };
        }
        return { ok: true, payload: handle };
      }
      handle = handle.replace(/[^A-Za-z0-9._]/g, '');
      if (!handle) return { ok: false, reason: 'Instagram მომხმარებელი არასწორია.' };
      return { ok: true, payload: 'https://instagram.com/' + handle };
    }
    if (type === 'wifi') {
      var ssid = String(f.ssid || '').trim();
      if (!ssid) return { ok: false, reason: 'Wi-Fi სახელი (SSID) შეიყვანეთ.' };
      var enc = f.enc === 'WEP' ? 'WEP' : f.enc === 'nopass' ? 'nopass' : 'WPA';
      var pass = String(f.password || '');
      if (enc !== 'nopass' && !pass) return { ok: false, reason: 'Wi-Fi პაროლი შეიყვანეთ.' };
      var payload = 'WIFI:T:' + enc + ';S:' + escapeWifiValue(ssid) + ';';
      if (enc !== 'nopass') payload += 'P:' + escapeWifiValue(pass) + ';';
      payload += ';';
      return { ok: true, payload: payload };
    }
    if (type === 'phone') {
      var raw = String(f.phone || '').trim().replace(/[\s()-]/g, '');
      if (!raw) return { ok: false, reason: 'ტელეფონის ნომერი შეიყვანეთ.' };
      if (!/^\+?\d{6,15}$/.test(raw)) return { ok: false, reason: 'ტელეფონის ნომერი არასწორია.' };
      return { ok: true, payload: 'tel:' + raw };
    }
    if (type === 'text') {
      var text = String(f.text || '');
      if (!text.trim()) return { ok: false, reason: 'ტექსტი შეიყვანეთ.' };
      if (text.length > MAX_PAYLOAD) return { ok: false, reason: 'ტექსტი ძალიან გრძელია (მაქს. 2048 სიმბოლო).' };
      return { ok: true, payload: text };
    }
    return { ok: false, reason: 'QR ტიპი არასწორია.' };
  }

  var api = {
    QR_TYPES: QR_TYPES,
    MAX_PAYLOAD: MAX_PAYLOAD,
    escapeWifiValue: escapeWifiValue,
    buildQrPayload: buildQrPayload,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.QrMaker = api;
})(typeof window !== 'undefined' ? window : globalThis);
