const state = {
  token: localStorage.getItem("adminToken"),
  view: "overview",
  autoRefresh: true,
  refreshTimer: null,
  liveEventSource: null,
  liveStreamUrl: null,
  liveRenderPending: false,
  sessionRole: localStorage.getItem("adminRole") || "",
  queueLive: {
    // rolling window of live queue points sampled on each render.
    points: [],
    maxPoints: 90, // ~7.5 minutes at 5s refresh
    lastSampleAt: 0,
  },
  requestFilters: {
    status: "",
    source_app: "",
    model: "",
    search: "",
    error_only: false,
  },
  requestPaging: {
    limit: 50,
    offset: 0,
    sort_by: "created_at",
    sort_dir: "desc",
  },
};

const loginPanel = document.getElementById("login-panel");
const appPanel = document.getElementById("app-panel");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const viewContainer = document.getElementById("view-container");
const viewTitle = document.getElementById("view-title");
const viewSubtitle = document.getElementById("view-subtitle");
const detailDrawer = document.getElementById("detail-drawer");
const logoutButton = document.getElementById("logout-button");
const sessionIndicator = document.getElementById("session-indicator");
const liveToggle = document.getElementById("live-toggle");

function setToken(token, role = "") {
  state.token = token || null;
  state.sessionRole = role || "";
  if (state.token) {
    localStorage.setItem("adminToken", state.token);
    localStorage.setItem("adminRole", role || "");
  } else {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminRole");
  }
}

function updateSessionIndicator(label = "") {
  const rolePart = state.sessionRole ? ` (${state.sessionRole})` : "";
  sessionIndicator.textContent = label ? `${label}${rolePart}` : rolePart.trim();
}

function setAutoRefresh(enabled) {
  state.autoRefresh = Boolean(enabled);
  liveToggle.textContent = state.autoRefresh ? "Live On" : "Live Off";
  liveToggle.classList.toggle("secondary-btn", !state.autoRefresh);
  scheduleRefresh();
}

function logout(reason = "") {
  setToken(null, "");
  stopRefresh();
  closeDrawer();
  showLogin();
  viewContainer.innerHTML = "";
  loginForm.reset();
  loginMessage.textContent = reason || "Logged out.";
  sessionIndicator.textContent = "";
}

function stopRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function isLiveStreamView() {
  return ["overview", "requests", "errors", "queue"].includes(state.view);
}

function closeLiveStream() {
  if (state.liveEventSource) {
    state.liveEventSource.close();
    state.liveEventSource = null;
  }
  state.liveStreamUrl = null;
}

function syncLiveStream() {
  if (!state.token || !state.autoRefresh || !isLiveStreamView()) {
    closeLiveStream();
    return;
  }
  const streamUrl = `/admin/stream${query({ access_token: state.token })}`;
  if (state.liveEventSource && state.liveStreamUrl === streamUrl) {
    return;
  }
  closeLiveStream();
  const source = new EventSource(streamUrl);
  source.addEventListener("snapshot", () => {
    if (state.liveRenderPending) return;
    state.liveRenderPending = true;
    window.setTimeout(async () => {
      state.liveRenderPending = false;
      if (state.autoRefresh && isLiveStreamView()) {
        await renderView();
      }
    }, 150);
  });
  source.onerror = () => {
    closeLiveStream();
    scheduleRefresh();
  };
  state.liveEventSource = source;
  state.liveStreamUrl = streamUrl;
}

function scheduleRefresh() {
  stopRefresh();
  if (!state.token || !state.autoRefresh || !isLiveStreamView() || state.liveEventSource) {
    return;
  }
  state.refreshTimer = window.setTimeout(() => {
    renderView();
  }, 5000);
}

function activeNav() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
}

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "" || value === false) return;
    search.set(key, String(value));
  });
  const built = search.toString();
  return built ? `?${built}` : "";
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) {
      logout("Session expired. Please sign in again.");
      throw new Error("Unauthorized");
    }
    throw new Error(await response.text());
  }
  return response.json();
}

function showApp() {
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
}

function showLogin() {
  closeLiveStream();
  loginPanel.classList.remove("hidden");
  appPanel.classList.add("hidden");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showDrawer(html) {
  detailDrawer.innerHTML = html;
  detailDrawer.classList.remove("hidden");
}

function closeDrawer() {
  detailDrawer.classList.add("hidden");
  detailDrawer.innerHTML = "";
}

function badge(status) {
  const normalized = String(status || "unknown").toLowerCase();
  return `<span class="pill ${escapeHtml(normalized)}">${escapeHtml(status || "unknown")}</span>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function chartSvg(points, color = "#0d6b5f") {
  if (!points.length) {
    return `<div class="muted">No data yet.</div>`;
  }
  const width = 520;
  const height = 180;
  const padding = 20;
  const values = points.map((point) => Number(point.value || 0));
  const max = Math.max(...values, 1);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = padding + step * index;
    const y = height - padding - ((Number(point.value || 0) / max) * (height - padding * 2));
    return { x, y, label: point.label, value: point.value };
  });
  const polyline = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const dots = coords
    .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3.5" fill="${color}"></circle>`)
    .join("");
  const labels = coords
    .map((point) => `<text x="${point.x}" y="${height - 4}" text-anchor="middle" font-size="11" fill="#6c777c">${escapeHtml(point.label)}</text>`)
    .join("");
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${dots}
      ${labels}
    </svg>`;
}

function sparkSvg(points, color = "#0d6b5f") {
  if (!points.length) return `<div class="muted">No data yet.</div>`;
  const width = 520;
  const height = 96;
  const padding = 10;
  const values = points.map((point) => Number(point.value || 0));
  const max = Math.max(...values, 1);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = padding + step * index;
    const y = height - padding - ((Number(point.value || 0) / max) * (height - padding * 2));
    return { x, y };
  });
  const polyline = coords.map((point) => `${point.x},${point.y}`).join(" ");
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    </svg>`;
}

function sampleQueueLive(queue, workers, ready) {
  const now = Date.now();
  // Avoid oversampling if someone mashes refresh.
  if (now - state.queueLive.lastSampleAt < 800) return;
  state.queueLive.lastSampleAt = now;

  const label = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const point = {
    label,
    waiting: Number(queue?.total_waiting || 0),
    active: Number(queue?.total_active || 0),
    workers: Array.isArray(workers) ? workers.length : 0,
    db: ready?.database === "up" ? 1 : 0,
    redis: ready?.redis === "up" ? 1 : 0,
  };
  state.queueLive.points.push(point);
  const max = state.queueLive.maxPoints || 90;
  if (state.queueLive.points.length > max) {
    state.queueLive.points.splice(0, state.queueLive.points.length - max);
  }
}

function barRows(items) {
  if (!items.length) return `<div class="muted">No data yet.</div>`;
  const max = Math.max(...items.map((item) => Number(item.value || 0)), 1);
  return `<div class="bars">${items
    .map(
      (item) => `
      <div class="bar-row">
        <div class="bar-head"><span>${escapeHtml(item.key)}</span><span>${formatNumber(item.value)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(Number(item.value || 0) / max) * 100}%"></div></div>
      </div>`,
    )
    .join("")}</div>`;
}

function metricCard(label, value, subvalue = "") {
  return `
    <div class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="subvalue">${escapeHtml(subvalue)}</div>
    </div>`;
}

function alertCards(alerts) {
  const activeAlerts = alerts.filter((alert) => alert.active);
  if (!activeAlerts.length) {
    return `<div class="card"><div class="label">Active Alerts</div><div class="subvalue">No active alerts right now.</div></div>`;
  }
  return activeAlerts
    .map(
      (alert) => `
      <div class="card alert-card ${escapeHtml(alert.severity)}">
        <div class="label">${escapeHtml(alert.code.replaceAll("_", " "))}</div>
        <div class="value small-value">${escapeHtml(String(alert.observed_value))}</div>
        <div class="subvalue">${escapeHtml(alert.message)}</div>
      </div>`,
    )
    .join("");
}

function table(rows, headers) {
  const head = headers.map((header) => `<th>${header}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<div class="card table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

async function renderOverview() {
  const [overview, errors] = await Promise.all([api("/admin/overview"), api("/admin/errors")]);
  // Phase 2 operations dashboard with queue intelligence, retries, slow-request diagnostics, and active alert surfacing.
  viewSubtitle.textContent = "";
  viewContainer.innerHTML = `
    <div class="grid kpi-grid">
      ${metricCard("Total Requests", formatNumber(overview.summary.total_requests), `${formatNumber(overview.summary.requests_today)} today`)}
      ${metricCard("Weekly Requests", formatNumber(overview.summary.requests_week), `${formatNumber(overview.summary.active_requests)} active now`)}
      ${metricCard("Daily Tokens", formatNumber(overview.summary.tokens_today), `${formatNumber(overview.summary.tokens_week)} this week`)}
      ${metricCard("Average Latency", `${formatNumber(Math.round(overview.summary.average_latency_ms))} ms`, `${overview.summary.error_rate}% errors`)}
      ${metricCard("Queue Depth", formatNumber(overview.summary.queue_depth), `${formatNumber(overview.queue.total_waiting)} waiting`)}
      ${metricCard("Active Requests", formatNumber(overview.summary.active_requests), `${overview.queue.models.length} queues tracked`)}
      ${metricCard("Queue Wait P95", `${formatNumber(Math.round(overview.summary.queue_wait_p95_ms || 0))} ms`, `${formatNumber(Math.round(overview.summary.queue_wait_avg_ms || 0))} ms avg`)}
      ${metricCard("Retry Rate", `${overview.summary.retry_rate}%`, `${formatNumber(overview.retry_summary.total_retry_events)} retry events`)}
      ${metricCard("Timeout Rate", `${overview.summary.timeout_rate}%`, `${overview.retry_summary.dead_lettered_requests} dead-lettered`)}
      ${metricCard("Slow Request Rate", `${overview.summary.slow_request_rate}%`, `${overview.slow_requests.length} top slow requests shown`)}
    </div>

    <div class="grid three-up" style="margin-top:16px">
      ${alertCards(overview.alerts)}
    </div>

    <div class="grid two-up" style="margin-top:16px">
      <div class="card chart-card">
        <div class="chart-meta"><div><div class="label">Requests Trend</div><div class="chart-caption">Daily requests over the last 7 days</div></div></div>
        ${chartSvg(overview.requests_series, "#0d6b5f")}
      </div>
      <div class="card chart-card">
        <div class="chart-meta"><div><div class="label">Token Trend</div><div class="chart-caption">Daily total tokens over the last 7 days</div></div></div>
        ${chartSvg(overview.tokens_series, "#2a8f7f")}
      </div>
      <div class="card chart-card">
        <div class="chart-meta"><div><div class="label">Error Trend</div><div class="chart-caption">Failed and timed out requests by day</div></div></div>
        ${chartSvg(overview.errors_series, "#a23b46")}
      </div>
      <div class="card chart-card">
        <div class="chart-meta"><div><div class="label">Latency Trend</div><div class="chart-caption">Average processing time by day</div></div></div>
        ${chartSvg(overview.latency_series, "#5e3bbf")}
      </div>
    </div>

    <div class="grid three-up" style="margin-top:16px">
      <div class="card"><div class="label">Status Breakdown</div>${barRows(overview.status_breakdown)}</div>
      <div class="card"><div class="label">Source Breakdown</div>${barRows(overview.source_breakdown)}</div>
      <div class="card"><div class="label">Model Breakdown</div>${barRows(overview.model_breakdown)}</div>
    </div>

    <div class="grid two-up" style="margin-top:16px">
      <div class="card">
        <div class="label">Retry Summary</div>
        <div class="bars">
          <div class="bar-row"><div class="bar-head"><span>Retried Requests</span><span>${formatNumber(overview.retry_summary.retried_requests)}</span></div></div>
          <div class="bar-row"><div class="bar-head"><span>Eventual Success</span><span>${formatNumber(overview.retry_summary.eventual_success_after_retry)}</span></div></div>
          <div class="bar-row"><div class="bar-head"><span>Currently Retrying</span><span>${formatNumber(overview.retry_summary.currently_retrying_jobs)}</span></div></div>
          <div class="bar-row"><div class="bar-head"><span>Dead Lettered</span><span>${formatNumber(overview.retry_summary.dead_lettered_requests)}</span></div></div>
        </div>
      </div>
      <div class="card">
        <div class="label">Top Slow Requests</div>
        ${overview.slow_requests.length ? overview.slow_requests.map((request) => `
          <div class="queue-card">
            <div class="inline-list">
              <button class="small-btn alt" data-request-id="${request.request_id}">Open</button>
              ${badge(request.status)}
            </div>
            <div class="subvalue">${escapeHtml(request.source_app || "unknown")} · ${escapeHtml(request.resolved_model || "-")}</div>
            <div class="subvalue">${formatNumber(request.processing_time_ms)} ms total${request.queue_wait_ms ? ` · ${formatNumber(request.queue_wait_ms)} ms queue wait` : ""}</div>
          </div>`).join("") : '<div class="muted">No slow requests above threshold.</div>'}
      </div>
    </div>

    <div class="grid two-up" style="margin-top:16px">
      <div class="card"><div class="label">Model Performance</div>${table(
        overview.model_performance.map((row) => [
          escapeHtml(row.key || "unknown"),
          formatNumber(row.request_count),
          `${formatNumber(Math.round(row.average_latency_ms || 0))} ms`,
          `${row.error_rate}%`,
          `${row.retry_rate}%`,
        ]),
        ["Model", "Requests", "Avg Latency", "Error Rate", "Retry Rate"],
      )}</div>
      <div class="card"><div class="label">Source Performance</div>${table(
        overview.source_performance.map((row) => [
          escapeHtml(row.key || "unknown"),
          formatNumber(row.request_count),
          `${formatNumber(Math.round(row.average_latency_ms || 0))} ms`,
          `${row.error_rate}%`,
          `${row.timeout_rate}%`,
        ]),
        ["Source", "Requests", "Avg Latency", "Error Rate", "Timeout Rate"],
      )}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="chart-meta"><div><div class="label">Live Queue Monitor</div><div class="chart-caption">Current active, waiting, saturation, retries, and queue age by model</div></div></div>
      <div class="queue-grid">
        ${overview.queue.models
          .map(
            (item) => `
            <div class="queue-card">
              <div><strong>${escapeHtml(item.model_name)}</strong></div>
              <div class="queue-metrics">
                <div class="mini"><div class="label">Active</div><div class="value">${formatNumber(item.active)}</div></div>
                <div class="mini"><div class="label">Waiting</div><div class="value">${formatNumber(item.waiting)}</div></div>
              </div>
              <div class="subvalue">Utilization ${item.utilization_pct}%${item.concurrency_limit ? ` of ${formatNumber(item.concurrency_limit)}` : ""}</div>
              <div class="subvalue">P95 wait ${formatNumber(Math.round(item.p95_wait_ms || 0))} ms · Oldest waiting ${formatNumber(Math.round(item.oldest_waiting_age_ms || 0))} ms</div>
              <div class="subvalue">Retrying ${formatNumber(item.retrying_jobs)} · Dead-lettered today ${formatNumber(item.dead_lettered_recent)}</div>
            </div>`,
          )
          .join("") || '<div class="muted">No active queues.</div>'}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="chart-meta"><div><div class="label">Worker Status</div><div class="chart-caption">Live worker heartbeats and task utilization</div></div></div>
      ${overview.workers.length ? table(
        overview.workers.map((worker) => [
          escapeHtml(worker.worker_id),
          escapeHtml(worker.status),
          formatNumber(worker.active_tasks),
          formatNumber(worker.max_parallel_jobs),
          `${worker.utilization_pct}%`,
          escapeHtml(formatDate(worker.last_seen_at)),
        ]),
        ["Worker", "Status", "Active Tasks", "Capacity", "Utilization", "Last Seen"],
      ) : '<div class="muted">No worker heartbeats detected.</div>'}
    </div>

    <div class="grid two-up" style="margin-top:16px">
      ${table(
        overview.recent_requests.map((request) => [
          `<button class="small-btn alt" data-request-id="${request.request_id}">Open</button>`,
          escapeHtml(request.source_app || "unknown"),
          escapeHtml(request.resolved_model || request.requested_model || "-"),
          badge(request.status),
          formatNumber(request.total_tokens || 0),
          formatDate(request.created_at),
        ]),
        ["Request", "Source", "Model", "Status", "Tokens", "Created"],
      )}
      ${table(
        errors.map((error) => [escapeHtml(error.error_code), formatNumber(error.count)]),
        ["Error Code", "Count"],
      )}
    </div>`;
  bindRequestLinks();
}

async function openRequestDetail(requestId) {
  const detail = await api(`/admin/requests/${requestId}`);
  showDrawer(`
    <div class="stack">
      <div class="actions"><button class="small-btn alt" id="close-drawer">Close</button></div>
      <div class="card stack">
        <div class="label">Request Summary</div>
        <div class="split">
          <div><strong>Request ID</strong><div>${escapeHtml(detail.request_id)}</div></div>
          <div><strong>Trace ID</strong><div>${escapeHtml(detail.trace_id)}</div></div>
          <div><strong>Source</strong><div>${escapeHtml(detail.source_app || "unknown")}</div></div>
          <div><strong>Status</strong><div>${badge(detail.status)}</div></div>
          <div><strong>User</strong><div>${escapeHtml(detail.user_display_name || detail.user_id || "-")}</div></div>
          <div><strong>Org</strong><div>${escapeHtml(detail.org_name || detail.org_id || "-")}</div></div>
          <div><strong>Model</strong><div>${escapeHtml(detail.resolved_model || detail.requested_model || "-")}</div></div>
          <div><strong>Latency</strong><div>${formatNumber(detail.processing_time_ms || 0)} ms</div></div>
          <div><strong>Queue Wait</strong><div>${formatNumber(detail.queue_wait_ms || 0)} ms</div></div>
          <div><strong>End To End</strong><div>${formatNumber(detail.end_to_end_ms || 0)} ms</div></div>
          <div><strong>Total Tokens</strong><div>${formatNumber(detail.total_tokens || 0)}</div></div>
          <div><strong>Prompt Tokens</strong><div>${formatNumber(detail.prompt_tokens || 0)}</div></div>
          <div><strong>Completion Tokens</strong><div>${formatNumber(detail.completion_tokens || 0)}</div></div>
          <div><strong>Retry Count</strong><div>${formatNumber(detail.retry_count || 0)}</div></div>
          <div><strong>Final Attempts</strong><div>${formatNumber(detail.final_attempts || 0)}</div></div>
          <div><strong>Dropped</strong><div>${escapeHtml(detail.dropped ? "yes" : "no")}</div></div>
          <div><strong>Client Cancelled</strong><div>${escapeHtml(detail.client_cancelled ? "yes" : "no")}</div></div>
          <div><strong>Failure Stage</strong><div>${escapeHtml(detail.failure_stage || "-")}</div></div>
          <div><strong>Dropped Reason</strong><div>${escapeHtml(detail.dropped_reason || "-")}</div></div>
          <div><strong>Mode</strong><div>${escapeHtml(detail.mode || "-")}</div></div>
          <div><strong>Created</strong><div>${formatDate(detail.created_at)}</div></div>
        </div>
        <div class="inline-list">
          ${detail.was_retried ? '<span class="pill retrying">retried</span>' : ''}
          ${detail.dead_lettered ? '<span class="pill failed">dead lettered</span>' : ''}
        </div>
      </div>

      <div class="card stack">
        <div class="label">Queue Jobs</div>
        ${detail.queue_jobs.length ? detail.queue_jobs.map((job) => `
          <div class="queue-card">
            <div class="inline-list">
              ${badge(job.status)}
              <span class="pill">attempts ${escapeHtml(job.attempts)}</span>
            </div>
            <div class="subvalue">${escapeHtml(job.model_name)} · queued ${escapeHtml(formatDate(job.queued_at))}</div>
            <div class="subvalue">Started ${escapeHtml(formatDate(job.started_at))} · Completed ${escapeHtml(formatDate(job.completed_at))}</div>
            ${job.error_message ? `<div class="json">${escapeHtml(job.error_message)}</div>` : ""}
          </div>`).join("") : '<div class="muted">No queue job persisted for this request.</div>'}
      </div>

      <div class="card stack">
        <div class="label">Lifecycle Events</div>
        <div class="timeline">
          ${detail.events.map((event) => `
            <div class="timeline-item">
              <strong>${escapeHtml(event.event_type)}</strong>
              <div class="subvalue">${escapeHtml(formatDate(event.created_at))}</div>
              ${event.details_json ? `<div class="json">${escapeHtml(JSON.stringify(event.details_json, null, 2))}</div>` : ""}
            </div>`).join("")}
        </div>
      </div>

      <div class="card stack">
        <div class="label">Input</div>
        <div class="json">${escapeHtml(detail.input_text || "")}</div>
        <div class="label">Responses</div>
        ${detail.responses.map((response) => `
          <div class="queue-card stack">
            <div class="inline-list">
              ${badge(response.success ? "completed" : "failed")}
              <span class="pill">${formatNumber(response.processing_time_ms || 0)} ms</span>
              <span class="pill">${formatNumber(response.usage.total_tokens || 0)} tokens</span>
            </div>
            <div class="json">${escapeHtml(JSON.stringify(response.response_payload_json, null, 2))}</div>
          </div>`).join("") || '<div class="muted">No responses stored.</div>'}
        <div class="label">Request Payload</div>
        <div class="json">${escapeHtml(JSON.stringify(detail.request_payload_json, null, 2))}</div>
      </div>
    </div>`);
  document.getElementById("close-drawer").addEventListener("click", closeDrawer);
}

function bindRequestLinks() {
  viewContainer.querySelectorAll("[data-request-id]").forEach((button) => {
    button.addEventListener("click", () => openRequestDetail(button.dataset.requestId));
  });
}

async function renderRequests() {
  const requests = await api(`/admin/requests${query({ ...state.requestPaging, ...state.requestFilters })}`);
  viewSubtitle.textContent = "Filter request traffic by status, source, model, and free-text correlation search.";
  viewContainer.innerHTML = `
    <div class="card stack">
      <div class="label">Request Explorer</div>
      <div class="filters">
        <label><span class="label">Status</span><select id="filter-status">
          <option value="">All</option>
          <option value="queued">Queued</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="timeout">Timeout</option>
        </select></label>
        <label><span class="label">Source App</span><select id="filter-source">
          <option value="">All</option>
          <option value="Evigstudio">Evigstudio</option>
          <option value="EvigstudioLight">EvigstudioLight</option>
          <option value="unknown">Unknown</option>
        </select></label>
        <label><span class="label">Model</span><input id="filter-model" placeholder="gemma, llama, gpt..." /></label>
        <label><span class="label">Search</span><input id="filter-search" placeholder="request id, trace id, user, org" /></label>
        <label><span class="label">Errors Only</span><select id="filter-errors-only"><option value="false">No</option><option value="true">Yes</option></select></label>
        <label><span class="label">Page Size</span><select id="filter-limit"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
        <label><span class="label">Sort By</span><select id="filter-sort-by"><option value="created_at">Created</option><option value="completed_at">Completed</option><option value="status">Status</option><option value="source_app">Source</option><option value="resolved_model">Model</option></select></label>
        <label><span class="label">Sort Dir</span><select id="filter-sort-dir"><option value="desc">Newest First</option><option value="asc">Oldest First</option></select></label>
        <div class="actions">
          <button class="small-btn" id="apply-request-filters">Apply</button>
          <button class="small-btn alt" id="reset-request-filters">Reset</button>
        </div>
      </div>
    </div>

    <div class="card paging-bar" style="margin-top:16px">
      <div class="actions">
        <button class="small-btn alt" id="prev-page" ${state.requestPaging.offset === 0 ? "disabled" : ""}>Previous</button>
        <button class="small-btn alt" id="next-page" ${requests.length < state.requestPaging.limit ? "disabled" : ""}>Next</button>
      </div>
      <div class="muted">Showing ${formatNumber(state.requestPaging.offset + 1)} to ${formatNumber(state.requestPaging.offset + requests.length)} with page size ${formatNumber(state.requestPaging.limit)}</div>
    </div>

    <div style="margin-top:16px">
      ${table(
        requests.map((request) => [
          `<button class="small-btn alt" data-request-id="${request.request_id}">Open</button>`,
          escapeHtml(request.source_app || "unknown"),
          escapeHtml(request.user_display_name || request.user_id || "-"),
          escapeHtml(request.org_name || request.org_id || "-"),
          escapeHtml(request.resolved_model || request.requested_model || "-"),
          badge(request.status),
          escapeHtml(request.error_code || "-"),
          formatNumber(request.total_tokens || 0),
          `${formatNumber(request.processing_time_ms || 0)} ms`,
          formatDate(request.created_at),
        ]),
        ["Request", "Source", "User", "Org", "Model", "Status", "Error", "Tokens", "Latency", "Created"],
      )}
    </div>`;

  document.getElementById("filter-status").value = state.requestFilters.status;
  document.getElementById("filter-source").value = state.requestFilters.source_app;
  document.getElementById("filter-model").value = state.requestFilters.model;
  document.getElementById("filter-search").value = state.requestFilters.search;
  document.getElementById("filter-errors-only").value = String(state.requestFilters.error_only);
  document.getElementById("filter-limit").value = String(state.requestPaging.limit);
  document.getElementById("filter-sort-by").value = state.requestPaging.sort_by;
  document.getElementById("filter-sort-dir").value = state.requestPaging.sort_dir;
  document.getElementById("apply-request-filters").addEventListener("click", async () => {
    state.requestFilters.status = document.getElementById("filter-status").value;
    state.requestFilters.source_app = document.getElementById("filter-source").value;
    state.requestFilters.model = document.getElementById("filter-model").value.trim();
    state.requestFilters.search = document.getElementById("filter-search").value.trim();
    state.requestFilters.error_only = document.getElementById("filter-errors-only").value === "true";
    state.requestPaging.limit = Number(document.getElementById("filter-limit").value);
    state.requestPaging.sort_by = document.getElementById("filter-sort-by").value;
    state.requestPaging.sort_dir = document.getElementById("filter-sort-dir").value;
    state.requestPaging.offset = 0;
    await renderRequests();
  });
  document.getElementById("reset-request-filters").addEventListener("click", async () => {
    state.requestFilters = { status: "", source_app: "", model: "", search: "", error_only: false };
    state.requestPaging = { limit: 50, offset: 0, sort_by: "created_at", sort_dir: "desc" };
    await renderRequests();
  });
  document.getElementById("prev-page").addEventListener("click", async () => {
    state.requestPaging.offset = Math.max(0, state.requestPaging.offset - state.requestPaging.limit);
    await renderRequests();
  });
  document.getElementById("next-page").addEventListener("click", async () => {
    state.requestPaging.offset += state.requestPaging.limit;
    await renderRequests();
  });
  bindRequestLinks();
}

async function renderErrors() {
  const [errors, failedRequests] = await Promise.all([
    api("/admin/errors"),
    api(`/admin/requests${query({ limit: 50, error_only: true })}`),
  ]);
  const overview = await api("/admin/overview");
  viewSubtitle.textContent = "Grouped error categories, timeout pressure, retries, and the latest failed or timed out traffic.";
  viewContainer.innerHTML = `
    <div class="grid three-up" style="margin-bottom:16px">
      ${metricCard("Error Rate", `${overview.summary.error_rate}%`, `${formatNumber(overview.summary.total_requests)} total requests`)}
      ${metricCard("Timeout Rate", `${overview.summary.timeout_rate}%`, `${formatNumber(overview.retry_summary.dead_lettered_requests)} dead-lettered`)}
      ${metricCard("Retry Rate", `${overview.summary.retry_rate}%`, `${formatNumber(overview.retry_summary.currently_retrying_jobs)} retrying jobs now`)}
    </div>
    <div class="grid two-up">
      ${table(errors.map((item) => [escapeHtml(item.error_code), formatNumber(item.count)]), ["Error Code", "Count"])}
      <div class="card"><div class="label">Error Category Distribution</div>${barRows(errors.map((item) => ({ key: item.error_code, value: item.count })))}</div>
    </div>
    <div style="margin-top:16px">
      ${table(
        failedRequests.map((request) => [
          `<button class="small-btn alt" data-request-id="${request.request_id}">Open</button>`,
          escapeHtml(request.source_app || "unknown"),
          escapeHtml(request.resolved_model || request.requested_model || "-"),
          badge(request.status),
          escapeHtml(request.error_code || "-"),
          formatDate(request.created_at),
        ]),
        ["Request", "Source", "Model", "Status", "Error", "Created"],
      )}
    </div>`;
  bindRequestLinks();
}

async function renderQueue() {
  const [queue, workers, ready] = await Promise.all([
    api("/admin/queue"),
    api("/admin/workers"),
    fetch("/ready").then((resp) => (resp.ok ? resp.json() : { status: "degraded", database: "down", redis: "down" })).catch(() => ({ status: "degraded", database: "down", redis: "down" })),
  ]);
  sampleQueueLive(queue, workers, ready);
  const livePoints = state.queueLive.points;
  const waitingSeries = livePoints.map((p) => ({ label: p.label, value: p.waiting }));
  const activeSeries = livePoints.map((p) => ({ label: p.label, value: p.active }));
  viewSubtitle.textContent = "Live queue health across model lanes, including wait-time pressure, saturation, retries, and backlog age.";
  viewContainer.innerHTML = `
    <div class="grid kpi-grid">
      ${metricCard("Active Requests", formatNumber(queue.total_active), "Currently processing")}
      ${metricCard("Queued Requests", formatNumber(queue.total_waiting), "Waiting in Redis queues")}
      ${metricCard("Tracked Queues", formatNumber(queue.models.length), "Discovered model lanes")}
      ${metricCard("Avg Queue Wait", `${formatNumber(Math.round(queue.avg_wait_ms || 0))} ms`, `P95 ${formatNumber(Math.round(queue.p95_wait_ms || 0))} ms`)}
      ${metricCard("Oldest Waiting", `${formatNumber(Math.round(queue.oldest_waiting_age_ms || 0))} ms`, `Max wait ${formatNumber(Math.round(queue.max_wait_ms || 0))} ms`)}
      ${metricCard("DB/Redis", `${escapeHtml(ready.database || "-")}/${escapeHtml(ready.redis || "-")}`, `status ${escapeHtml(ready.status || "-")}`)}
    </div>

    <div class="grid two-up" style="margin-top:16px">
      <div class="card chart-card">
        <div class="chart-meta"><div><div class="label">Queued (Live)</div><div class="chart-caption">Total waiting in Redis (last ~8 minutes)</div></div></div>
        ${sparkSvg(waitingSeries, "#a23b46")}
      </div>
      <div class="card chart-card">
        <div class="chart-meta"><div><div class="label">Active (Live)</div><div class="chart-caption">Total active slots across model lanes</div></div></div>
        ${sparkSvg(activeSeries, "#0d6b5f")}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="label">Model Queue Lanes</div>
      <div class="queue-grid" style="margin-top:14px">
        ${queue.models.map((item) => `
          <div class="queue-card">
            <div><strong>${escapeHtml(item.model_name)}</strong></div>
            <div class="queue-metrics">
              <div class="mini"><div class="label">Active</div><div class="value">${formatNumber(item.active)}</div></div>
              <div class="mini"><div class="label">Waiting</div><div class="value">${formatNumber(item.waiting)}</div></div>
            </div>
            <div class="subvalue">Utilization ${item.utilization_pct}%${item.concurrency_limit ? ` of ${formatNumber(item.concurrency_limit)}` : ""}</div>
            <div class="subvalue">Avg wait ${formatNumber(Math.round(item.avg_wait_ms || 0))} ms · P95 ${formatNumber(Math.round(item.p95_wait_ms || 0))} ms</div>
            <div class="subvalue">Oldest waiting ${formatNumber(Math.round(item.oldest_waiting_age_ms || 0))} ms · Retrying ${formatNumber(item.retrying_jobs)}</div>
          </div>`).join("") || '<div class="muted">No queue activity.</div>'}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="label">Worker Heartbeats</div>
      ${workers.length ? table(
        workers.map((worker) => [
          escapeHtml(worker.worker_id),
          escapeHtml(worker.status),
          formatNumber(worker.active_tasks),
          formatNumber(worker.max_parallel_jobs),
          `${worker.utilization_pct}%`,
          escapeHtml(formatDate(worker.last_seen_at)),
        ]),
        ["Worker", "Status", "Active Tasks", "Capacity", "Utilization", "Last Seen"],
      ) : '<div class="muted">No worker heartbeats detected.</div>'}
    </div>`;
}

async function updateConfig(key, currentValue) {
  const raw = window.prompt(`Update config ${key}`, JSON.stringify(currentValue));
  if (raw === null) return;
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : "";
  } catch {
    parsed = raw;
  }
  await api(`/admin/config/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value_json: parsed }),
  });
  await renderConfig();
}

async function renderConfig() {
  const config = await api("/admin/config");
  viewSubtitle.textContent = "Runtime configuration with role-protected edits and audit-backed change history.";
  viewContainer.innerHTML = table(
    config.map((item) => [
      escapeHtml(item.key),
      badge(item.scope),
      `<div class="json">${escapeHtml(JSON.stringify(item.value_json, null, 2))}</div>`,
      escapeHtml(item.updated_by || "-"),
      item.editable_from_ui ? `<button class="small-btn" data-config-key="${item.key}">Edit</button>` : "-",
    ]),
    ["Key", "Scope", "Value", "Updated By", "Action"],
  );
  viewContainer.querySelectorAll("[data-config-key]").forEach((button) => {
    const item = config.find((entry) => entry.key === button.dataset.configKey);
    button.addEventListener("click", () => updateConfig(item.key, item.value_json));
  });
}

async function updateModel(name, current) {
  const backendUrl = window.prompt(`Backend URL for ${name}`, current.backend_url);
  if (backendUrl === null) return;
  const concurrency = window.prompt(`Concurrency limit for ${name}`, String(current.concurrency_limit));
  if (concurrency === null) return;
  const queue = window.prompt(`Queue limit for ${name}`, String(current.queue_limit));
  if (queue === null) return;
  const timeout = window.prompt(`Timeout seconds for ${name}`, String(current.timeout_seconds));
  if (timeout === null) return;
  await api(`/admin/models/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({
      backend_url: backendUrl,
      concurrency_limit: Number(concurrency),
      queue_limit: Number(queue),
      timeout_seconds: Number(timeout),
      is_enabled: current.is_enabled,
      alias: current.alias,
      fallback_model: current.fallback_model,
    }),
  });
  await renderModels();
}

async function renderModels() {
  const models = await api("/admin/models");
  viewSubtitle.textContent = "Model routing and queue lane settings used by the orchestrator worker.";
  viewContainer.innerHTML = table(
    models.map((model) => [
      escapeHtml(model.name),
      escapeHtml(model.alias || "-"),
      escapeHtml(model.backend_url),
      formatNumber(model.concurrency_limit),
      formatNumber(model.queue_limit),
      badge(model.is_enabled ? "enabled" : "disabled"),
      `<button class="small-btn" data-model-name="${model.name}">Edit</button>`,
    ]),
    ["Name", "Alias", "Backend", "Concurrency", "Queue", "Status", "Action"],
  );
  viewContainer.querySelectorAll("[data-model-name]").forEach((button) => {
    const model = models.find((entry) => entry.name === button.dataset.modelName);
    button.addEventListener("click", () => updateModel(model.name, model));
  });
}

async function renderAudit() {
  const logs = await api("/admin/audit-logs");
  viewSubtitle.textContent = "Admin activity trail for authentication, request inspection, and configuration changes.";
  viewContainer.innerHTML = table(
    logs.map((log) => [
      escapeHtml(log.actor),
      escapeHtml(log.action),
      escapeHtml(log.target_type),
      escapeHtml(log.target_key),
      formatDate(log.created_at),
    ]),
    ["Actor", "Action", "Target Type", "Target Key", "Created"],
  );
}

async function renderView() {
  activeNav();
  viewTitle.textContent = state.view[0].toUpperCase() + state.view.slice(1);
  try {
    if (state.view === "overview") await renderOverview();
    if (state.view === "requests") await renderRequests();
    if (state.view === "errors") await renderErrors();
    if (state.view === "queue") await renderQueue();
    if (state.view === "models") await renderModels();
    if (state.view === "config") await renderConfig();
    if (state.view === "audit") await renderAudit();
  } catch (error) {
    closeDrawer();
    viewContainer.innerHTML = `<div class="card"><div class="json">${escapeHtml(error.message)}</div></div>`;
  }
  syncLiveStream();
  scheduleRefresh();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  try {
    const payload = await api("/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    setToken(payload.access_token, payload.role);
    loginMessage.textContent = "Login successful";
    updateSessionIndicator(`Signed in as ${formData.get("username")}`);
    showApp();
    await renderView();
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.view = button.dataset.view;
    await renderView();
  });
});

document.getElementById("refresh-button").addEventListener("click", renderView);
logoutButton.addEventListener("click", () => logout("You have been logged out."));
liveToggle.addEventListener("click", () => setAutoRefresh(!state.autoRefresh));

if (state.token) {
  updateSessionIndicator("Signed in");
  setAutoRefresh(true);
  showApp();
  renderView();
} else {
  setAutoRefresh(true);
  showLogin();
}
