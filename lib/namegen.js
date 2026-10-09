/**
 * Brand / domain name generator.
 *
 * Two engines:
 *  - "classic": fast, offline, rule-based (variants of a seed name + keyword blends)
 *  - "claude":  asks Claude for creative names that fit the seed and the description
 */

const STOPWORDS = new Set(`a an and are as at be but by for from has have i in into is it its of on or our
that the their them they this to was we what which who will with you your company product app platform
service business help helps make makes build builds people users tool tools based using use new best`.split(/\s+/));

const PREFIXES = ['get', 'try', 'use', 'go', 'my', 'hey', 'the', 'join', 'meet'];
const SUFFIXES = ['ly', 'ify', 'io', 'o', 'a', 'er', 'r', 'hq', 'lab', 'labs', 'hub', 'kit', 'base', 'stack', 'flow', 'wise', 'able', 'ster', 'sy', 'iq'];
const VOWELS = 'aeiou';

function clean(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function keywords(description) {
  const words = String(description || '').toLowerCase().match(/[a-z]{3,}/g) || [];
  const out = [];
  for (const w of words) if (!STOPWORDS.has(w) && !out.includes(w)) out.push(w);
  return out.slice(0, 12);
}

function stem(w) {
  return w.replace(/(ing|ers|er|ed|es|s|ly|tion|ment)$/, '') || w;
}

/** Portmanteau: overlap the end of a with the start of b if possible, else cut at a vowel. */
function blend(a, b) {
  for (let k = Math.min(a.length, b.length) - 1; k >= 2; k--) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  }
  const cut = Math.max(3, a.search(/[aeiou][^aeiou]/) + 2);
  return a.slice(0, cut) + b.slice(Math.max(0, b.search(/[aeiou]/)));
}

function seedVariants(seed) {
  const s = clean(seed);
  if (!s) return [];
  const out = new Set();
  const root = s.replace(/[aeiouy]+$/, '') || s;

  for (const suf of SUFFIXES) out.add(root + suf);
  for (const pre of PREFIXES) out.add(pre + s);
  out.add(s.replace(/[aeiou]/g, (v, i) => (i === 0 ? v : '')));        // drop vowels (Flickr style)
  out.add(s.replace(/er$/, 'r'));
  out.add(s.replace(/c(?=[aou])|ck/g, 'k').replace(/ph/g, 'f').replace(/s$/, 'z'));
  out.add(s.replace(/i/g, 'y'));
  out.add(s.replace(/([^aeiou])$/, '$1$1') + 'o');
  // swap each vowel for the other vowels
  for (let i = 0; i < s.length; i++) {
    if (!VOWELS.includes(s[i])) continue;
    for (const v of VOWELS) if (v !== s[i]) out.add(s.slice(0, i) + v + s.slice(i + 1));
  }
  out.delete(s);
  return [...out];
}

function keywordCombos(words, seed) {
  const out = new Set();
  const stems = words.map(stem).filter(w => w.length >= 3);
  const s = clean(seed);
  for (let i = 0; i < stems.length; i++) {
    for (let j = 0; j < stems.length; j++) {
      if (i === j) continue;
      out.add(stems[i] + stems[j]);
      out.add(blend(stems[i], stems[j]));
    }
    for (const suf of ['ly', 'ify', 'io', 'hq', 'hub', 'flow', 'base']) out.add(stems[i] + suf);
    if (s) {
      out.add(blend(s, stems[i]));
      out.add(blend(stems[i], s));
      out.add(s + stems[i]);
    }
  }
  return [...out];
}

function score(name) {
  // Prefer short, pronounceable names
  let sc = 100 - Math.abs(name.length - 7) * 6;
  if (/[^aeiouy]{4,}/.test(name)) sc -= 25;
  if (/[aeiou]{3,}/.test(name)) sc -= 15;
  if (/(.)\1\1/.test(name)) sc -= 30;
  return sc;
}

function classic({ seed, description, count = 40 }) {
  const words = keywords(description);
  const pool = new Map();
  for (const n of seedVariants(seed)) pool.set(n, 'Variation of your seed name');
  for (const n of keywordCombos(words, seed)) if (!pool.has(n)) pool.set(n, 'Built from your description');
  return [...pool.entries()]
    .filter(([n]) => n.length >= 3 && n.length <= 18)
    .map(([name, rationale]) => ({ name, rationale, score: score(name) + Math.random() * 10 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ name, rationale }) => ({ name, rationale }));
}

const NAMES_SCHEMA = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase domain label: letters and digits only, no TLD' },
          rationale: { type: 'string', description: 'One short sentence on why it fits' },
        },
        required: ['name', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['names'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)();
  }
  return client;
}

async function withClaude({ seed, description, style, count = 40 }) {
  const brief = [
    seed && `Names we like (match their feel, sound and length): ${seed}`,
    description && `What the company/product does: ${description}`,
    style && `Style / theme: ${style}`,
  ].filter(Boolean).join('\n');

  const response = await getClient().beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: NAMES_SCHEMA },
    },
    system: 'You are a naming consultant who creates brandable startup and product names. '
      + 'Names must work as domain labels: lowercase a-z and 0-9 only, 4-14 characters, easy to say and spell. '
      + 'Mix techniques: invented words, blends, real words used in new ways, and subtle variations of the names the client likes. '
      + 'Avoid well-known existing brands and trademarks. Prefer names that are plausibly still unregistered as .com, so lean toward inventive spellings over common dictionary words.',
    messages: [{ role: 'user', content: `${brief}\n\nGive me ${count} name ideas.` }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text);
  return parsed.names
    .map(n => ({ name: clean(n.name), rationale: n.rationale }))
    .filter(n => n.name.length >= 2);
}

async function generate(opts) {
  if (opts.engine === 'claude') return withClaude(opts);
  return classic(opts);
}

module.exports = { generate, classic };
