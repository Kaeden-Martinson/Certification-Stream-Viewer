/**
 * Domain registration lookups via RDAP (the JSON successor to WHOIS).
 *
 * - 200 from the TLD's authoritative RDAP server  -> registered (with creation date)
 * - 404                                          -> available
 * - TLD has no RDAP server (e.g. many ccTLDs)    -> DNS fallback: NXDOMAIN = "likely available"
 */

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT = 8;

// ccTLDs that serve RDAP but are missing from the IANA bootstrap file
const EXTRA_SERVERS = {
  io: 'https://rdap.identitydigital.services/rdap/',
  sh: 'https://rdap.identitydigital.services/rdap/',
  ac: 'https://rdap.identitydigital.services/rdap/',
  me: 'https://rdap.identitydigital.services/rdap/',
};

let bootstrap = null;      // Map<tld, baseUrl>
let bootstrapLoading = null;
const cache = new Map();   // domain -> { at, result }

let active = 0;
const waiting = [];         // background (feed) lookups
const waitingPriority = []; // interactive lookups jump ahead of the feed
async function limited(fn, priority) {
  if (active >= MAX_CONCURRENT) await new Promise(r => (priority ? waitingPriority : waiting).push(r));
  active++;
  try { return await fn(); } finally {
    active--;
    const next = waitingPriority.shift() || waiting.shift();
    if (next) next();
  }
}

async function loadBootstrap() {
  if (bootstrap) return bootstrap;
  if (!bootstrapLoading) {
    bootstrapLoading = fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(j => {
        const map = new Map(Object.entries(EXTRA_SERVERS));
        for (const [tlds, urls] of j.services) {
          const url = urls.find(u => u.startsWith('https')) || urls[0];
          for (const t of tlds) map.set(t.toLowerCase(), url.replace(/\/?$/, '/'));
        }
        bootstrap = map;
        return map;
      })
      .catch(err => { bootstrapLoading = null; throw err; });
  }
  return bootstrapLoading;
}

// DNS-over-HTTPS (works the same on every OS, unlike the system resolver)
async function dnsFallback(domain) {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    // Status 3 = NXDOMAIN: the name doesn't exist in the TLD zone
    if (body.Status === 3) return { status: 'likely-available', created: null, source: 'dns' };
    if (body.Status === 0) return { status: 'registered', created: null, source: 'dns' };
    return { status: 'unknown', created: null, source: 'dns', error: `DNS status ${body.Status}` };
  } catch (err) {
    return { status: 'unknown', created: null, source: 'dns', error: err.message };
  }
}

async function rdapLookup(domain) {
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  const map = await loadBootstrap();
  const base = map.get(tld);
  if (!base) return dnsFallback(domain);

  const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
    headers: { Accept: 'application/rdap+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { status: 'available', created: null, source: 'rdap' };
  if (!res.ok) {
    // Rate limited or server error - DNS gives a partial answer
    const fallback = await dnsFallback(domain);
    return { ...fallback, note: `rdap ${res.status}` };
  }
  const body = await res.json();
  const reg = (body.events || []).find(e => e.eventAction === 'registration');
  const exp = (body.events || []).find(e => e.eventAction === 'expiration');
  return {
    status: 'registered',
    created: reg ? reg.eventDate : null,
    expires: exp ? exp.eventDate : null,
    source: 'rdap',
  };
}

/** Look up a domain. Results are cached for 30 minutes. */
async function lookup(domain, { priority = false } = {}) {
  domain = domain.toLowerCase();
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  let result;
  try {
    result = await limited(() => rdapLookup(domain), priority);
  } catch (err) {
    result = { status: 'unknown', created: null, source: 'rdap', error: err.message };
  }
  cache.set(domain, { at: Date.now(), result });
  if (cache.size > 50000) cache.delete(cache.keys().next().value);
  return result;
}

/** Number of lookups waiting for a slot - lets callers shed load. */
function queueDepth() {
  return waiting.length;
}

module.exports = { lookup, queueDepth };
