// @mengls1620/dsh-deepseek-status — host half.
//
// Polls the DeepSeek official status page (status.deepseek.com, a Flashcat
// status page) and serves the parsed snapshot over an exact route on the
// existing web server, so the browser half can read it same-origin without
// CORS.
//
// Config comes from the bundle row's `config` (cordis.patch.yml), validated
// against the exported `Config` schema; a missing row config falls back to
// the defaults below.
//
// The fields are marked `.volatile()`. That is what makes the Host settings
// service project them into an editable form ("Forms expose only volatile
// fields from active, uniquely addressed profile entries"), and what keeps the
// parsed values live: Cordis commits a volatile-only config change into the
// running references without remounting, so an edit applies without a restart.
// DSH 0.2 removed the settings-seam helpers this plugin used to register with
// (`installSettingsSection` / `settings.installSection` / the
// `settings/updated` event); declaring volatile fields replaces them on the host
// side, and the browser half (lib/client.js) contributes the form itself —
// DSH 0.2 has no client that builds one from a schema.
import z from "@deepseek-ai/schemastery";
import { parseStatusPage } from "./parser.js";

const name = "@mengls1620/dsh-deepseek-status";
/** The web server is a web-profile-only service; without it this fiber stays pending. */
const inject = ["webServer", "timer"];

/**
 * Plugin config schema; defaults keep the row config optional.
 *
 * `.volatile()` on each field is load-bearing: without it the Host projects no
 * form and the plugin's settings disappear from the UI again.
 */
const Config = z.object({
  statusUrl: z.string().default("https://status.deepseek.com/").volatile(),
  pollIntervalMs: z.number().min(15000).max(3600000).default(60000).volatile(),
  timeoutMs: z.number().min(5000).max(120000).default(15000).volatile(),
});

const ROUTE_PATH = "/deepseek-status/current";

const FALLBACK = {
  statusUrl: "https://status.deepseek.com/",
  pollIntervalMs: 60000,
  timeoutMs: 15000,
};

/**
 * Hard cap on the decompressed status page. The page measured ~216 KiB on
 * 2026-11-18; 2 MiB leaves ~9.5x headroom and keeps a hostile or broken
 * upstream from exhausting memory. A body over the cap is a failed fetch: the
 * last good snapshot is kept and the panel reports the failure.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Only an absolute http(s) URL is a usable status page. The host validates
 * here so the browser never has to render a `javascript:` or `file:` link, and
 * the route below reports the validated value back to the panel.
 */
function httpUrlOrNull(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read one parsed config field.
 *
 * A volatile field parses into a stable reference whose value is read through
 * `get()`, and Cordis swaps that value in place when the profile changes. A
 * plain value — an older or non-volatile schema — is returned as-is.
 */
function readField(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function"
    ? value.get()
    : value;
}

/**
 * Normalize one config object, falling back to the defaults above.
 *
 * Read on every use rather than once at activation: the volatile references are
 * the live values, so re-reading is what lets an edited interval take effect
 * without a restart.
 */
function resolveSettings(config) {
  const c = config ?? {};
  const statusUrl = readField(c.statusUrl);
  const pollIntervalMs = readField(c.pollIntervalMs);
  const timeoutMs = readField(c.timeoutMs);
  return {
    statusUrl: httpUrlOrNull(statusUrl) ?? FALLBACK.statusUrl,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : FALLBACK.pollIntervalMs,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FALLBACK.timeoutMs,
  };
}

function sameSettings(a, b) {
  return a.statusUrl === b.statusUrl
    && a.pollIntervalMs === b.pollIntervalMs
    && a.timeoutMs === b.timeoutMs;
}

/**
 * Read a response body without ever holding more than `limit` bytes.
 *
 * Fetch decompresses transparently, so the bytes counted here are the bytes
 * the parser would actually see. A body over the cap is cancelled early; the
 * caller turns that into a normal fetch failure.
 */
async function readBodyLimited(res, limit) {
  if (res.body === null || res.body === undefined || typeof res.body.getReader !== "function") {
    const text = await res.text();
    return new TextEncoder().encode(text).byteLength > limit ? { tooLarge: true } : { text };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged) };
}

function apply(ctx, entryConfig = {}) {
  let snapshot = null; // last good snapshot
  let lastError = null;
  let disposeTimer = null;
  /** One fetch at a time: a trigger during a fetch queues exactly one follow-up. */
  let inFlight = false;
  let pendingRefresh = false;
  /** Identifies the latest refresh; an older, slower result is discarded. */
  let refreshSeq = 0;
  /** The settings the running timer was armed for; config events compare against it. */
  let lastSettings = resolveSettings(entryConfig);
  /** Resolved per use: the row config holds the live volatile references. */
  const resolveConfig = () => resolveSettings(entryConfig);

  async function refresh() {
    if (inFlight) {
      pendingRefresh = true;
      return;
    }
    inFlight = true;
    const seq = ++refreshSeq;
    try {
      const { statusUrl, timeoutMs } = resolveConfig();
      const res = await fetch(statusUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await readBodyLimited(res, MAX_RESPONSE_BYTES);
      if (body.tooLarge) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      const data = parseStatusPage(body.text);
      if (seq === refreshSeq) {
        snapshot = { ...data, fetchedAt: Date.now(), error: null };
        lastError = null;
      }
    } catch (error) {
      if (seq === refreshSeq) {
        lastError = String(error?.message ?? error);
        ctx.logger?.warn?.(`@mengls1620/dsh-deepseek-status: refresh failed: ${lastError}`);
      }
    } finally {
      inFlight = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        void refresh();
      }
    }
  }

  function disarm() {
    if (disposeTimer !== null) disposeTimer();
    disposeTimer = null;
  }

  function arm() {
    // Cordis returns a disposer, not a native setInterval handle.
    disarm();
    disposeTimer = ctx.setInterval(() => { void refresh(); }, resolveConfig().pollIntervalMs);
  }

  /**
   * `loader/volatile-update` fires for every plugin's volatile config commit,
   * not just ours. Compare our resolved values and do nothing when they did
   * not change, so an unrelated edit cannot re-arm the timer or fetch again.
   */
  function onVolatileUpdate() {
    const next = resolveConfig();
    if (sameSettings(next, lastSettings)) return;
    const previous = lastSettings;
    lastSettings = next;
    if (next.pollIntervalMs !== previous.pollIntervalMs) arm();
    if (next.statusUrl !== previous.statusUrl || next.timeoutMs !== previous.timeoutMs) {
      void refresh();
    }
  }

  // No settings seam to register: the Host reads the form off the exported
  // `Config` schema (its volatile fields), so declaring `Config` both validates
  // the row config and publishes the editable fields.
  //
  // A saved form edit is a volatile-only config change, which Cordis commits
  // into the running references and announces as `loader/volatile-update`
  // instead of remounting the fiber. Re-arming there is what makes a new
  // interval take effect without a restart; it replaces the old
  // `settingsHooks.onChange() { arm(); }`. Reading the values per use is the
  // other half, because those references are live.
  ctx.on("loader/volatile-update", onVolatileUpdate);

  ctx.effect(() => {
    void refresh();
    arm();
    return disarm;
  }, "@mengls1620/dsh-deepseek-status: poller");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      // The panel's "open status page" link must follow the configured page,
      // so the validated URL travels with the snapshot.
      const { statusUrl } = resolveConfig();
      const body = snapshot !== null
        ? JSON.stringify({ ...snapshot, statusUrl, error: lastError })
        : JSON.stringify({
            overall: "unknown",
            components: [],
            active: [],
            recentResolved: [],
            uptime: [],
            updatedAt: null,
            fetchedAt: null,
            statusUrl,
            error: lastError ?? "no data yet",
          });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    },
  }), "@mengls1620/dsh-deepseek-status: route");

  ctx.logger?.info?.(`@mengls1620/dsh-deepseek-status: polling ${resolveConfig().statusUrl} every ${resolveConfig().pollIntervalMs}ms`);
}

export { apply, Config, inject, name };
