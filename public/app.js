(() => {
  const $ = (selector) => document.querySelector(`[data-bind="${selector}"]`);
  const state = { data: null, filter: "all", query: "" };

  const statusMeta = {
    waiting: { label: "Waiting", tone: "gray" },
    printing: { label: "Printing", tone: "blue" },
    retrying: { label: "Retrying", tone: "amber" },
    completed: { label: "Printed", tone: "green" },
    failed: { label: "Failed", tone: "red" },
  };

  const displayStatus = (job) => (job.status === "waiting" && job.nextRetryAt ? "retrying" : job.status);

  function countdown(iso) {
    const seconds = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  function jobNote(job) {
    if (displayStatus(job) !== "retrying") return job.message;
    const due = new Date(job.nextRetryAt).getTime() <= Date.now();
    return `${due ? "Retrying now" : `Next retry in ${countdown(job.nextRetryAt)}`} · ${job.message}`;
  }
  const driverLabels = { tcp: "Network", usb: "USB", windows: "Windows", virtual: "Virtual" };

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
    })[char]);

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

  function relative(iso) {
    if (!iso) return "—";
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return dateFormat.format(new Date(iso));
  }

  function duration(ms) {
    if (ms === undefined || ms === null) return "—";
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function badge(status) {
    const meta = statusMeta[status] || { label: status, tone: "gray" };
    return `<span class="badge tone-${meta.tone}${status === "printing" ? " is-live" : ""}">${meta.label}</span>`;
  }

  function matches(job) {
    const status = displayStatus(job);
    if (state.filter === "active" && !["waiting", "printing"].includes(status)) return false;
    if (state.filter === "retrying" && status !== "retrying") return false;
    if (state.filter === "failed" && status !== "failed") return false;
    if (!state.query) return true;
    const haystack = `${job.id} ${job.printer} ${job.preview} ${job.message} ${job.address}`.toLowerCase();
    return haystack.includes(state.query);
  }

  function renderRows() {
    const jobs = (state.data?.jobs || []).filter(matches);
    $("rows").innerHTML = jobs
      .map((job) => ({ job, status: displayStatus(job) }))
      .map(
        ({ job, status }) => `<tr data-id="${esc(job.id)}" class="${status === "failed" ? "row-failed" : status === "retrying" ? "row-retrying" : ""}">
          <td class="col-time"><strong>${esc(timeFormat.format(new Date(job.receivedAt)))}</strong><small>${esc(relative(job.receivedAt))}</small></td>
          <td class="receipt-cell">
            <div class="printer-line"><strong>${esc(job.printer)}</strong><span class="chip">${esc(driverLabels[job.driverType] || job.driverType)}</span></div>
            <span class="preview">${esc(job.preview || "(empty)")}</span>
          </td>
          <td class="col-status">
            <div class="status-line">${badge(status)}<span class="meta">${esc([duration(job.durationMs), job.attempts > 1 ? `${job.attempts} attempts` : ""].filter((part) => part && part !== "—").join(" · "))}</span></div>
            <small class="msg${status === "failed" ? " msg-error" : status === "retrying" ? " msg-warn" : ""}" title="${esc(job.message)}">${esc(jobNote(job))}</small>
          </td>
          <td class="actions col-actions">
            ${["failed", "retrying"].includes(status) ? `<button type="button" class="btn btn-sm btn-primary" data-retry="${esc(job.id)}">${status === "failed" ? "Retry" : "Retry now"}</button>` : ""}
            <button type="button" class="btn btn-sm btn-ghost" data-view="${esc(job.id)}">View</button>
          </td>
        </tr>`
      )
      .join("");
    $("empty").hidden = jobs.length > 0;
  }

  const printerStates = {
    online: { label: "Online", tone: "green" },
    offline: { label: "Offline", tone: "red" },
    disabled: { label: "Disabled", tone: "gray" },
    checking: { label: "Checking", tone: "blue" },
  };

  function renderPrinters() {
    const printers = state.data?.printers || [];
    const active = printers.filter((printer) => printer.active);
    const online = active.filter((printer) => printer.state === "online").length;
    $("printersSummary").textContent = printers.length
      ? `${online} of ${active.length} active printer${active.length === 1 ? "" : "s"} online${
          printers.length > active.length ? ` · ${printers.length - active.length} disabled` : ""
        }`
      : "Loaded from the shop in Print Service.";
    $("printersEmpty").hidden = printers.length > 0;
    $("printers").innerHTML = printers
      .map((printer) => {
        const meta = printerStates[printer.state] || printerStates.checking;
        const details = [
          printer.latencyMs !== undefined ? `${printer.latencyMs} ms` : "",
          printer.checkedAt ? `checked ${relative(printer.checkedAt)}` : "",
        ].filter(Boolean).join(" · ");
        return `<div class="printer printer-${esc(printer.state)}">
          <div class="printer-head">
            <span class="printer-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg></span>
            <div class="printer-name"><strong title="${esc(printer.name)}">${esc(printer.name)}</strong><span class="chip">${esc(driverLabels[printer.driverType] || printer.driverType)}</span></div>
            <span class="badge tone-${meta.tone}${printer.state === "checking" ? " is-live" : ""}">${meta.label}</span>
          </div>
          <code class="printer-address" title="${esc(printer.address)}">${esc(printer.address)}</code>
          <p class="printer-msg${printer.state === "offline" ? " msg-error" : ""}" title="${esc(printer.message)}">${esc(printer.message)}</p>
          ${details ? `<small class="printer-meta">${esc(details)}</small>` : ""}
        </div>`;
      })
      .join("");
  }

  async function checkNow(button) {
    button.disabled = true;
    try {
      const response = await fetch("/printers/check", { method: "POST" });
      state.data = await response.json();
      renderStatus();
      renderPrinters();
      renderRows();
    } finally {
      button.disabled = false;
    }
  }

  function renderStatus() {
    const data = state.data;
    if (!data) return;
    const counts = { ...data.counts, active: data.counts.waiting + data.counts.printing };
    document.querySelectorAll("[data-count]").forEach((node) => {
      node.textContent = counts[node.dataset.count] ?? 0;
    });

    const conn = $("conn");
    const tone = data.connected ? "online" : data.paired ? "error" : "idle";
    conn.className = `conn conn-${tone}`;
    const text = data.connected
      ? `Online · ${data.shopName || "shop"}`
      : data.connectionError || (data.paired ? "Connecting…" : "Not paired");
    $("connText").textContent = text;
    $("shop").textContent = data.shopName || (data.paired ? "Connecting…" : "Not paired");
    $("shopName").textContent = data.shopName || "—";
    $("since").textContent = data.connectedSince ? relative(data.connectedSince) : "—";
    $("queue").textContent = counts.active || counts.retrying
      ? [
          data.counts.printing ? `${data.counts.printing} printing` : "",
          data.counts.waiting ? `${data.counts.waiting} waiting` : "",
          data.counts.retrying ? `${data.counts.retrying} retrying` : "",
        ].filter(Boolean).join(" · ")
      : "Idle";
    if (data.retry) {
      const { maxAttempts, baseDelayMs, maxDelayMs } = data.retry;
      $("queueHint").textContent = `Printed jobs are removed automatically. Failed jobs retry every ${Math.round(baseDelayMs / 1000)}s, doubling up to ${Math.round(maxDelayMs / 60000)} min${maxAttempts ? `, ${maxAttempts} attempts max` : ", until printed"}.`;
    }
    if (data.storage) {
      const size = data.storage.sizeBytes < 1024 * 1024
        ? `${Math.max(1, Math.round(data.storage.sizeBytes / 1024))} KB`
        : `${(data.storage.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
      $("storage").textContent = `${data.storage.engine} · ${data.storage.totalJobs} jobs · ${size}${
        data.storage.unacked ? ` · ${data.storage.unacked} unsynced` : ""
      }`;
      $("storage").title = data.storage.file;
    }
    $("connBadge").innerHTML = data.connected
      ? '<span class="badge tone-green">Online</span>'
      : `<span class="badge tone-${data.paired ? "red" : "gray"}">${data.paired ? "Offline" : "Not paired"}</span>`;
    document.title = `${counts.active ? `(${counts.active}) ` : ""}Print Client${data.shopName ? ` · ${data.shopName}` : ""}`;
  }

  async function refresh() {
    try {
      const response = await fetch("/status", { cache: "no-store" });
      state.data = await response.json();
      renderStatus();
      renderPrinters();
      renderRows();
    } catch {
      $("connText").textContent = "Print Client unreachable";
      $("conn").className = "conn conn-error";
    }
  }

  async function retry(id) {
    await fetch(`/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    await refresh();
  }

  async function view(id) {
    const response = await fetch(`/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return;
    const job = await response.json();
    $("dTitle").textContent = job.printer;
    $("dContent").textContent = job.content
      .replace(/^\u001bSIZE:[a-z]+\u001b\n?/, "")
      .replace(/\u001bIMAGE:\d+\u001b/g, "[image]")
      .replace(/\u001bS:[a-z]*\u001b/g, "");
    const status = displayStatus(job);
    $("dDetails").innerHTML = [
      ["Status", badge(status)],
      ["Message", esc(job.message)],
      ...(status === "retrying" ? [["Next retry", esc(`${new Date(job.nextRetryAt).toLocaleTimeString()} (in ${countdown(job.nextRetryAt)})`)]] : []),
      ["Driver", esc(driverLabels[job.driverType] || job.driverType)],
      ["Address", `<span class="mono">${esc(job.address)}</span>`],
      ["Received", esc(new Date(job.receivedAt).toLocaleString())],
      ["Duration", esc(duration(job.durationMs))],
      ["Bytes", esc(job.bytes ?? "—")],
      ["Attempts", esc(job.attempts)],
      ["Deliveries", esc(job.deliveries)],
      ["Synced to service", ["completed", "failed"].includes(job.status) ? (job.acked ? "Yes" : "Pending") : "—"],
      ["Job ID", `<span class="mono">${esc(job.id)}</span>`],
    ]
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
      .join("");
    const retryButton = $("dRetry");
    retryButton.hidden = !["failed", "retrying"].includes(status);
    retryButton.textContent = "Retry now";
    retryButton.onclick = async () => {
      $("dialog").close();
      await retry(job.id);
    };
    const removeButton = $("dRemove");
    removeButton.hidden = job.status === "printing" || job.status === "completed";
    removeButton.onclick = async () => {
      if (!window.confirm("Remove this job? It will not be printed.")) return;
      $("dialog").close();
      await fetch(`/jobs/${encodeURIComponent(job.id)}/remove`, { method: "POST" });
      await refresh();
    };
    $("dialog").showModal();
  }

  const logState = { entries: [], level: "all", limit: 0, timer: 0 };
  const logTimeFormat = new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  function renderLogs() {
    const list = $("logList");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const entries = logState.entries.filter((entry) => logState.level === "all" || entry.level === logState.level);
    document.querySelectorAll("[data-log-count]").forEach((node) => {
      const level = node.dataset.logCount;
      node.textContent = level === "all" ? logState.entries.length : logState.entries.filter((entry) => entry.level === level).length;
    });
    list.innerHTML = entries.length
      ? entries
          .map(
            (entry) => `<div class="log-row log-${esc(entry.level)}">
              <span class="log-time" title="${esc(new Date(entry.time).toLocaleString())}">${esc(logTimeFormat.format(new Date(entry.time)))}</span>
              <span class="log-level">${esc(entry.level)}</span>
              <span class="log-message">${esc(entry.message)}</span>
            </div>`
          )
          .join("")
      : '<div class="log-empty">No log entries</div>';
    if (atBottom) list.scrollTop = list.scrollHeight;
    $("logHint").textContent = `Keeps the last ${logState.limit} entries in memory since the service started. Updates every 2 seconds.`;
  }

  async function loadLogs() {
    try {
      const response = await fetch("/logs", { cache: "no-store" });
      const data = await response.json();
      const changed = data.entries.at(-1)?.id !== logState.entries.at(-1)?.id || data.entries.length !== logState.entries.length;
      logState.entries = data.entries;
      logState.limit = data.limit;
      if (changed) renderLogs();
    } catch {
      $("logHint").textContent = "Print Client unreachable";
    }
  }

  async function openLogs() {
    const list = $("logList");
    $("logDialog").showModal();
    await loadLogs();
    renderLogs();
    list.scrollTop = list.scrollHeight;
    window.clearInterval(logState.timer);
    logState.timer = window.setInterval(loadLogs, 2000);
  }

  $("logDialog").addEventListener("close", () => window.clearInterval(logState.timer));
  $("logDialog").addEventListener("click", (event) => {
    if (event.target === $("logDialog")) $("logDialog").close();
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-logs]")) {
      void openLogs();
      return;
    }
    const levelTab = event.target.closest("[data-log-level]");
    if (levelTab) {
      logState.level = levelTab.dataset.logLevel;
      document.querySelectorAll("[data-log-level]").forEach((item) => item.classList.toggle("active", item === levelTab));
      renderLogs();
      $("logList").scrollTop = $("logList").scrollHeight;
      return;
    }
    const tab = event.target.closest("[data-filter]");
    if (tab) {
      state.filter = tab.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === tab));
      renderRows();
      return;
    }
    const retryButton = event.target.closest("[data-retry]");
    if (retryButton) {
      retryButton.disabled = true;
      void retry(retryButton.dataset.retry);
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      void view(viewButton.dataset.view);
      return;
    }
    const checkButton = event.target.closest("[data-check]");
    if (checkButton && !checkButton.disabled) void checkNow(checkButton);
  });

  document.querySelector("[data-search]").addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderRows();
  });

  document.querySelector("[data-clear]").addEventListener("submit", (event) => {
    if (!window.confirm("Remove failed jobs that gave up retrying? They will not be printed.")) event.preventDefault();
  });

  $("dialog").addEventListener("click", (event) => {
    if (event.target === $("dialog")) $("dialog").close();
  });

  void refresh();
  window.setInterval(refresh, 2000);
  window.setInterval(() => {
    if (state.data?.counts?.retrying) renderRows();
  }, 1000);
})();
