function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS"
    }
  });
}

async function dispatch(env, force) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "PostKina-Reels-API"
    },
    body: JSON.stringify({ ref: "main", inputs: { force: String(force) } })
  });
  if (!response.ok) throw new Error(`GitHub dispatch ${response.status}: ${await response.text()}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") === env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "postkina-reels-api" }, 200, origin);
    if (request.method === "POST" && url.pathname === "/generate") {
      if (!env.REELS_ADMIN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.REELS_ADMIN_TOKEN}`) return json({ error: "Unauthorized" }, 401, origin);
      try { await dispatch(env, true); return json({ ok: true, queued: true }, 202, origin); }
      catch (error) { return json({ error: error.message }, 502, origin); }
    }
    return json({ error: "Not found" }, 404, origin);
  }
};

