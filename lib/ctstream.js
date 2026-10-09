/**
 * Certificate Transparency stream.
 *
 * Polls every currently-usable RFC 6962 CT log (from Google's official log list),
 * parses each certificate with Node's built-in X509 parser and emits the
 * registrable domains (eTLD+1) it covers.
 */

const { EventEmitter } = require('events');
const { X509Certificate } = require('crypto');
const { parse } = require('tldts');

const LOG_LIST_URL = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';
const POLL_MS = 1500;
const PARALLEL_FETCHES = 4;    // get-entries requests per log per poll
const MAX_LAG = 3000;          // if we fall further behind than this, skip ahead to the tip
const SEEN_LIMIT = 200000;     // dedupe window for registrable domains

async function getJSON(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function loadUsableLogs() {
  const list = await getJSON(LOG_LIST_URL);
  const now = Date.now();
  const logs = [];
  for (const op of list.operators) {
    for (const l of op.logs || []) {
      const state = Object.keys(l.state || {})[0];
      const t = l.temporal_interval;
      if (!['usable', 'qualified'].includes(state)) continue;
      if (t && (Date.parse(t.start_inclusive) > now || Date.parse(t.end_exclusive) <= now)) continue;
      logs.push({
        name: l.description,
        operator: op.name,
        url: l.url.replace(/\/$/, '') + '/ct/v1',
        next: null,
        errors: 0,
        busy: false,
      });
    }
  }
  return logs;
}

/** Extract the certificate DER from a get-entries entry (x509 or precert). */
function entryToCert(entry) {
  const leaf = Buffer.from(entry.leaf_input, 'base64');
  const entryType = leaf.readUInt16BE(10);
  let der;
  if (entryType === 0) {
    const len = leaf.readUIntBE(12, 3);
    der = leaf.subarray(15, 15 + len);
  } else {
    // precert: extra_data starts with the full pre-certificate
    const extra = Buffer.from(entry.extra_data, 'base64');
    const len = extra.readUIntBE(0, 3);
    der = extra.subarray(3, 3 + len);
  }
  const timestamp = Number(leaf.readBigUInt64BE(2));
  return { cert: new X509Certificate(der), timestamp };
}

function certNames(cert) {
  const names = new Set();
  for (const part of (cert.subjectAltName || '').split(', ')) {
    if (part.startsWith('DNS:')) names.add(part.slice(4).toLowerCase());
  }
  const cn = /CN=([^\n]+)/.exec(cert.subject || '');
  if (cn) names.add(cn[1].toLowerCase());
  return names;
}

function issuerOrg(cert) {
  const m = /O=([^\n]+)/.exec(cert.issuer || '');
  return m ? m[1].replace(/^"|"$/g, '') : 'Unknown';
}

class CTStream extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.running = false;
    this.timer = null;
    this.seen = new Set();
    this.stats = { certs: 0, domains: 0, startedAt: null };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = Date.now();
    if (!this.logs.length) {
      this.logs = await loadUsableLogs();
      this.emit('status', `Watching ${this.logs.length} CT logs`);
    }
    const tick = () => {
      if (!this.running) return;
      for (const log of this.logs) if (!log.busy) this.pollLog(log);
      this.timer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  async pollLog(log) {
    log.busy = true;
    try {
      const sth = await getJSON(`${log.url}/get-sth`, 5000);
      const size = sth.tree_size;
      if (log.next === null || size - log.next > MAX_LAG) log.next = Math.max(0, size - 64);

      // Fire several range requests in parallel; logs cap each response (often ~32 entries).
      const jobs = [];
      let start = log.next;
      for (let i = 0; i < PARALLEL_FETCHES && start < size; i++) {
        const end = Math.min(start + 31, size - 1);
        jobs.push(getJSON(`${log.url}/get-entries?start=${start}&end=${end}`).then(r => ({ start, entries: r.entries || [] })));
        start = end + 1;
      }
      const results = await Promise.allSettled(jobs);
      // Advance only through the contiguous prefix of successful fetches.
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value.entries.length) break;
        this.handleEntries(log, r.value.entries);
        log.next = r.value.start + r.value.entries.length;
      }
      log.errors = 0;
    } catch (err) {
      log.errors++;
      if (log.errors === 5) this.emit('status', `Log ${log.name} failing: ${err.message}`);
    } finally {
      log.busy = false;
    }
  }

  handleEntries(log, entries) {
    for (const entry of entries) {
      let parsed;
      try { parsed = entryToCert(entry); } catch { continue; }
      this.stats.certs++;
      const { cert, timestamp } = parsed;
      const roots = new Set();
      for (const name of certNames(cert)) {
        const p = parse(name.replace(/^\*\./, ''));
        if (p.domain && p.isIcann) roots.add(p.domain);
      }
      for (const domain of roots) {
        if (this.seen.has(domain)) continue;
        if (this.seen.size >= SEEN_LIMIT) this.seen.delete(this.seen.values().next().value);
        this.seen.add(domain);
        this.stats.domains++;
        this.emit('domain', {
          domain,
          tld: domain.slice(domain.indexOf('.') + 1),
          issuer: issuerOrg(cert),
          log: log.name,
          seenAt: timestamp,
        });
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      running: this.running,
      logs: this.logs.map(l => ({ name: l.name, operator: l.operator, healthy: l.errors < 5 })),
    };
  }
}

module.exports = { CTStream };
