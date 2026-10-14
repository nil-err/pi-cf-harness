# pi-cf-harness

Run the [Pi Durable](https://earendil.com/posts/pi-durable/) harness in a Cloudflare Durable Object with
[`PiHarness`](https://developers.cloudflare.com/agents/harnesses/pi/) from the Agents SDK, and serve models through
**Cloudflare AI Gateway** instead of Workers AI.

```
client (browser / curl)
    │  https://<your-worker-host>
    ▼
Worker fetch handler
    │  env.Assistant.getByName(<session>)          one Durable Object per conversation
    ▼
Agent (Agents SDK) + PiHarness (Lifecycle capability)
    ├─ Durable Object SQLite: Pi's transcript, inbox, tasks (tables prefixed pi_)
    ├─ Pi's scheduler is in memory; when the object is evicted the Lifecycle job's
    │  alarm restarts it and Pi resumes from its last checkpoint
    └─ model calls → Pi AI custom provider
             │  <CF_GATEWAY_URL>
             ▼
        AI Gateway (gateway auth) → provider keys stay on the gateway (BYOK)
```

Everything deployment-specific is configuration, not code: the gateway URL, the model catalog, and the credentials come
from the worker's environment. This repository contains no account, domain, or model names.

## Configuration

| Binding | Kind | Meaning |
| --- | --- | --- |
| `CF_GATEWAY_URL` | var | Base URL of the gateway, e.g. a gateway custom domain |
| `PI_MODELS` | var | JSON array of model specs (below) |
| `PI_MODEL` | var, optional | Default model id; defaults to the first entry of `PI_MODELS` |
| `CLOUDFLARE_GATEWAY_TOKEN` | secret | Sent as `cf-aig-authorization` on every request |
| `CF_ACCESS_CLIENT_ID` | secret, optional | Cloudflare Access service token, if the gateway's providers sit behind Access |
| `CF_ACCESS_CLIENT_SECRET` | secret, optional | Same |

A model spec is `{ id, name?, path?, contextWindow?, maxTokens?, reasoning?, compat?, thinkingLevelMap? }`.
`path` is appended to `CF_GATEWAY_URL` (default `/compat`), and may also be an absolute URL. Example:

```json
[
  { "id": "vendor/some-model", "name": "Some model", "path": "/compat", "reasoning": true,
    "contextWindow": 200000, "maxTokens": 32768 },
  { "id": "some-other-model", "path": "/my-custom-provider/v1", "contextWindow": 116000, "maxTokens": 8192 }
]
```

Model names, ids, and upstream routing are the gateway's business: whatever string the gateway accepts as `model` is what
goes here.

### If your gateway's providers are behind Access

Gateways can route to custom providers whose own endpoints are protected by Cloudflare Access. In that case the request
must carry the `CF-Access-Client-Id` / `CF-Access-Client-Secret` service-token headers, and the gateway returns a plain
`400` / `AiGatewayError 7003 Bad request` when they are missing — which is easy to mistake for a malformed request. Set
the two optional secrets and the worker sends them; omit them and the headers stay out entirely.

## Deploy

```bash
npm install

npx wrangler secret put CLOUDFLARE_GATEWAY_TOKEN
# only for Access-protected upstreams:
# npx wrangler secret put CF_ACCESS_CLIENT_ID
# npx wrangler secret put CF_ACCESS_CLIENT_SECRET

cp wrangler.jsonc wrangler.personal.jsonc     # untracked; add your vars and route there
npx wrangler deploy --config wrangler.personal.jsonc
```

Put `vars` (gateway URL, model catalog) and `routes` (custom domain) in `wrangler.personal.jsonc`, so the committed
config stays generic. Deployment-specific files are git-ignored.

## Endpoints

| Route | Description |
| --- | --- |
| `GET /` | Minimal page: pick a model, send a prompt, read the answer |
| `POST /api/ask` | `{ "prompt": "...", "model": "...", "session": "..." }` → `{ session, model, status, text, reason? }` |
| `GET /api/ask?prompt=...&session=...&model=...` | Same, for `curl` |
| `GET /api/models` | The configured catalog plus the default |
| `GET /api/state?session=...` | `{ id, busy, entries }` for one conversation |

`session` selects the Durable Object, i.e. the conversation. Memory isolation is per session.
`status` is `done` or `unanswered`; `reason` carries Pi's own reason (e.g. `model_error`) when a run does not answer.

## Notes and limitations

- `PiHarness` is in beta; the Pi Durable API may change.
- Session event streaming (`session.events()`) is not wired to a WebSocket here: the API is request/response. A client
  would open a stream after `session.events()` and forward `snapshot` + event batches.
- The worker has no auth of its own. Put it behind Cloudflare Access (or your own gate) before exposing a hostname that
  can spend gateway quota.
- Switching a session's model is durable. If a model is later removed from `PI_MODELS`, that session's next run ends
  `unanswered`; use a new session.
- Durable Objects have memory and CPU limits. Exceeding them evicts the object, and the next alarm resumes Pi from its
  last checkpoint — that is the durable part.
