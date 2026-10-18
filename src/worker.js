// SwitchSetup website backend (Cloudflare Worker).
// Static files in ./web are served directly by Cloudflare. This script only
// handles /api/*, which lets the in-browser builder fetch GitHub release files
// (GitHub doesn't allow browsers to download them directly).
//
// It is NOT an open proxy: it only serves files from the latest release of the
// repositories listed in app/catalog.json.
//
// Optional secret for a higher GitHub API limit:
//   npx wrangler secret put GITHUB_TOKEN

import catalog from "../app/catalog.json";

const RELEASES_TTL = 30 * 60; // seconds
const ASSET_TTL = 7 * 24 * 60 * 60;
const CACHE_HOST = "https://cache.switchsetup.internal";

const repos = [...new Set(catalog.packages.filter((p) => p.repo).map((p) => p.repo))];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed" }, 405);
    }
    try {
      if (url.pathname === "/api/catalog") return json(catalog, 200, 300);
      if (url.pathname === "/api/releases") return await releases(env, ctx);
      if (url.pathname === "/api/asset") return await asset(url, env, ctx);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "Server error" }, 502);
    }
  },
};

function json(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

function ghHeaders(env, accept = "application/vnd.github+json") {
  const h = { "user-agent": "SwitchSetup-Web", accept };
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

/** Latest release of one repo, trimmed to what the builder needs. Cached for 30 minutes. */
async function latestRelease(repo, env, ctx) {
  const cache = caches.default;
  const key = new Request(`${CACHE_HOST}/release/${repo}`);
  const staleKey = new Request(`${CACHE_HOST}/release-stale/${repo}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: ghHeaders(env) });
  if (!r.ok) {
    // GitHub refused (usually its hourly limit): fall back to the last known release.
    const stale = await cache.match(staleKey);
    if (stale) return stale.json();
    throw new Error(r.status === 403 || r.status === 429
      ? "GitHub rate limit reached, please try again in a few minutes."
      : `GitHub returned ${r.status} for ${repo}`);
  }
  const rel = await r.json();
  const data = {
    repo,
    tag: rel.tag_name,
    url: rel.html_url,
    publishedAt: rel.published_at,
    assets: rel.assets.map((a) => ({ name: a.name, size: a.size, download: a.browser_download_url })),
  };
  const body = JSON.stringify(data);
  ctx.waitUntil(Promise.all([
    cache.put(key, new Response(body, { headers: { "cache-control": `public, max-age=${RELEASES_TTL}` } })),
    cache.put(staleKey, new Response(body, { headers: { "cache-control": `public, max-age=${ASSET_TTL}` } })),
  ]));
  return data;
}

async function releases(env, ctx) {
  const results = await Promise.all(repos.map(async (repo) => {
    try {
      const rel = await latestRelease(repo, env, ctx);
      // Download URLs stay server-side; the browser asks /api/asset by file name.
      return { ...rel, assets: rel.assets.map(({ name, size }) => ({ name, size })) };
    } catch (e) {
      return { repo, error: e.message };
    }
  }));
  return json(results, 200, 120);
}

/** /api/asset?repo=owner/name&name=file.zip → the file from that repo's latest release. */
async function asset(url, env, ctx) {
  const repo = url.searchParams.get("repo");
  const name = url.searchParams.get("name");
  if (!repo || !name || !repos.includes(repo)) return json({ error: "Unknown package" }, 400);

  const rel = await latestRelease(repo, env, ctx);
  const a = rel.assets.find((x) => x.name === name);
  if (!a) return json({ error: `${name} is not in the latest ${repo} release` }, 404);

  const cache = caches.default;
  const key = new Request(`${CACHE_HOST}/asset/${repo}/${encodeURIComponent(rel.tag)}/${encodeURIComponent(name)}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const r = await fetch(a.download, { headers: { "user-agent": "SwitchSetup-Web" }, redirect: "follow" });
  if (!r.ok) return json({ error: `Download of ${name} failed (${r.status})` }, 502);

  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(a.size),
    "cache-control": `public, max-age=${ASSET_TTL}, immutable`,
  };
  const [forClient, forCache] = r.body.tee();
  ctx.waitUntil(cache.put(key, new Response(forCache, { headers })));
  return new Response(forClient, { headers });
}
