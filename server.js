/**
 * Cert Stream Viewer
 *  - Live feed of domains appearing in Certificate Transparency logs, with RDAP
 *    registration dates so freshly purchased domains stand out.
 *  - Name finder: generate brandable names, check availability, link to registrars.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { CTStream } = require('./lib/ctstream');
const rdap = require('./lib/rdap');
const namegen = require('./lib/namegen');
const { buyLinks } = require('./lib/registrars');

const PORT = process.env.PORT || 8080;
const FILTERS_PATH = path.join(__dirname, 'filters.json');
const BACKLOG_SIZE = 500;
const MAX_RDAP_BACKLOG = 40; // skip age lookups for the feed when the queue is this deep
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_FILTERS = {
  tlds: [],            // e.g. ["com", "io"]; empty = all
  include: [],         // domain must contain one of these
  exclude: [],         // domain must not contain any of these
  lookupAge: true,     // RDAP-check matching domains for their registration date
  maxAgeDays: 30,      // "newly registered" threshold
};

function loadFilters() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8'));
    // Only keep keys we understand (older filters.json files had a different shape)
    const filters = { ...DEFAULT_FILTERS };
    for (const key of Object.keys(DEFAULT_FILTERS)) if (key in saved) filters[key] = saved[key];
    return filters;
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

let filters = loadFilters();

function normalizeList(v) {
  if (typeof v === 'string') v = v.split(/[\s,]+/);
  return (Array.isArray(v) ? v : []).map(s => String(s).trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}

function passesFilters(item) {
  if (filters.tlds.length && !filters.tlds.includes(item.tld)) return false;
  if (filters.include.length && !filters.include.some(k => item.domain.includes(k))) return false;
  if (filters.exclude.some(k => item.domain.includes(k))) return false;
  return true;
}

// ============================================
// LIVE FEED
// ============================================

const stream = new CTStream();
const clients = new Set();
const backlog = [];
const stats = { matched: 0, newlyRegistered: 0 };

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function remember(item) {
  backlog.push(item);
  if (backlog.length > BACKLOG_SIZE) backlog.shift();
}

stream.on('status', msg => {
  console.log(`[CT] ${msg}`);
  broadcast('status', { message: msg });
});

stream.on('domain', item => {
  if (!passesFilters(item)) return;
  stats.matched++;
  item.age = filters.lookupAge ? 'pending' : 'off';
  remember(item);
  broadcast('domain', item);

  if (!filters.lookupAge) return;
  if (rdap.queueDepth() > MAX_RDAP_BACKLOG) {
    item.age = 'skipped';
    broadcast('age', { domain: item.domain, age: 'skipped' });
    return;
  }
  rdap.lookup(item.domain).then(r => {
    item.created = r.created;
    item.ageDays = r.created ? Math.floor((Date.now() - Date.parse(r.created)) / DAY_MS) : null;
    item.age = r.created ? 'known' : 'unknown';
    item.isNew = item.ageDays !== null && item.ageDays <= filters.maxAgeDays;
    if (item.isNew) stats.newlyRegistered++;
    broadcast('age', { domain: item.domain, age: item.age, created: item.created, ageDays: item.ageDays, isNew: item.isNew });
  });
});

// ============================================
// ROUTES
// ============================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/feed', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: backlog\ndata: ${JSON.stringify(backlog)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.post('/api/feed/start', async (req, res) => {
  try {
    await stream.start();
    res.json({ success: true });
  } catch (err) {
    stream.stop();
    res.status(502).json({ error: `Could not load CT log list: ${err.message}` });
  }
});

app.post('/api/feed/stop', (req, res) => {
  stream.stop();
  res.json({ success: true });
});

app.get('/api/feed/stats', (req, res) => {
  res.json({ ...stream.getStats(), ...stats, rdapQueue: rdap.queueDepth() });
});

app.get('/api/filters', (req, res) => res.json(filters));

app.post('/api/filters', (req, res) => {
  const b = req.body || {};
  filters = {
    tlds: normalizeList(b.tlds ?? filters.tlds),
    include: normalizeList(b.include ?? filters.include),
    exclude: normalizeList(b.exclude ?? filters.exclude),
    lookupAge: b.lookupAge ?? filters.lookupAge,
    maxAgeDays: Math.max(1, parseInt(b.maxAgeDays ?? filters.maxAgeDays, 10) || DEFAULT_FILTERS.maxAgeDays),
  };
  fs.writeFileSync(FILTERS_PATH, JSON.stringify(filters, null, 2));
  res.json(filters);
});

// ============================================
// NAME FINDER
// ============================================

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

app.post('/api/names', async (req, res) => {
  const { seed = '', description = '', style = '', engine = 'classic' } = req.body || {};
  const count = Math.min(80, Math.max(5, parseInt(req.body?.count, 10) || 40));
  if (!seed.trim() && !description.trim()) {
    return res.status(400).json({ error: 'Enter a name you like or a description of your company' });
  }
  try {
    const names = await namegen.generate({ seed, description, style, engine, count });
    res.json({ engine, names });
  } catch (err) {
    console.error('[NAMES]', err.message);
    // Fall back to the offline generator so the user still gets results
    const names = namegen.classic({ seed, description, count });
    const reason = /authentication|api.?key/i.test(err.message)
      ? 'no API key found; set ANTHROPIC_API_KEY and restart the server'
      : err.message;
    res.json({ engine: 'classic', names, warning: `Claude unavailable (${reason}), so the built-in generator was used.` });
  }
});

app.get('/api/check/:domain', async (req, res) => {
  const domain = req.params.domain.toLowerCase().trim();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain' });
  const result = await rdap.lookup(domain, { priority: true });
  res.json({
    domain,
    ...result,
    links: buyLinks(domain),
    certsUrl: `https://crt.sh/?q=${encodeURIComponent(domain)}`,
  });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ============================================
// START
// ============================================

const server = app.listen(PORT, () => {
  console.log(`\nCert Stream Viewer running at http://localhost:${PORT}/\n`);
  if (process.env.AUTOSTART !== '0') stream.start().catch(err => console.error('[CT] start failed:', err.message));
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3000 npm start`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});
