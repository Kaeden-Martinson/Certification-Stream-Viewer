# Cert Stream Viewer

A local web app with two tools:

- **Live feed**: streams domains as they get TLS certificates, from every Certificate Transparency log Chrome currently trusts. Each domain is looked up over RDAP to find its registration date, and anything registered in the last N days gets a **NEW** badge. Turn on *Only newly registered* to see just freshly bought domains.
- **Name finder**: enter names you like and/or a description of your company. It generates brandable names, checks each one across the extensions you pick, and gives available domains one-click links to buy on Cloudflare, Namecheap, GoDaddy, Porkbun or Spaceship.

## Run

```bash
npm install
npm start            # http://localhost:8080  (PORT=3000 npm start to change)
```

To use the **Claude** name generator, set an Anthropic API key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
```

Without a key, the app falls back to the built-in offline generator.

## How availability is checked

| Result | Meaning |
|---|---|
| **available** | The TLD's official RDAP server says the domain doesn't exist (404). Reliable. |
| **likely** | The TLD has no public RDAP server (.co, .gg, .so, .us…), so DNS-over-HTTPS was used: the name has no DNS records. Usually available, but confirm at checkout. |
| **taken** | Registered. Hover to see the registration date. |

Premium or reserved names can show as available but cost more, or be blocked, at the registrar.

## Layout

```
server.js            Express server + API routes
lib/ctstream.js      CT log poller (Google's v3 log list, Node's built-in X509 parser)
lib/rdap.js          RDAP / DNS-over-HTTPS lookups with caching and a priority queue
lib/namegen.js       Name generation (built-in rules + Claude)
lib/registrars.js    Registrar buy links
public/index.html    The UI
filters.json         Saved live-feed filters
```
