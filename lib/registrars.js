/**
 * Registrar search/buy links for a domain.
 */

const REGISTRARS = [
  { id: 'cloudflare', name: 'Cloudflare', url: d => `https://domains.cloudflare.com/?domain=${d}` },
  { id: 'namecheap', name: 'Namecheap', url: d => `https://www.namecheap.com/domains/registration/results/?domain=${d}` },
  { id: 'godaddy', name: 'GoDaddy', url: d => `https://www.godaddy.com/domainsearch/find?domainToCheck=${d}` },
  { id: 'porkbun', name: 'Porkbun', url: d => `https://porkbun.com/checkout/search?q=${d}` },
  { id: 'spaceship', name: 'Spaceship', url: d => `https://www.spaceship.com/domain-search/?query=${d}` },
];

function buyLinks(domain) {
  const d = encodeURIComponent(domain);
  return REGISTRARS.map(r => ({ id: r.id, name: r.name, url: r.url(d) }));
}

module.exports = { buyLinks, REGISTRARS };
