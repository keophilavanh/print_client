import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { io, type Socket } from "socket.io-client";
import { openStore, validImages, type PrintJob, type RasterImage, type ShopPrinter } from "./db";

const port = Number(process.env.PORT);
const serviceUrl = process.env.PRINT_SERVICE_URL ;
const dataDirectory = process.env.PRINT_CLIENT_DATA_DIR || "./data";
const publicDirectory = path.join(__dirname, "../public");
const historyLimit = Number(process.env.PRINT_HISTORY_LIMIT);
const listLimit = Number(process.env.PRINT_LIST_LIMIT);
const checkIntervalMs = Number(process.env.PRINTER_CHECK_INTERVAL_MS);
const checkTimeoutMs = Number(process.env.PRINTER_CHECK_TIMEOUT_MS);
const ackTimeoutMs = Number(process.env.PRINT_ACK_TIMEOUT_MS);
const retry = {
  maxAttempts: Number(process.env.PRINT_RETRY_MAX_ATTEMPTS),
  baseDelayMs: Number(process.env.PRINT_RETRY_BASE_DELAY_MS ),
  maxDelayMs: Number(process.env.PRINT_RETRY_MAX_DELAY_MS ),
};
const printedRetentionDays = Number(process.env.PRINT_PRINTED_RETENTION_DAYS );

type PrinterCheck = {
  state: "online" | "offline" | "disabled" | "checking";
  message: string;
  latencyMs?: number;
  checkedAt?: string;
};

const store = openStore(dataDirectory, { historyLimit, printedRetentionDays });
let shopCode = store.getSetting("shop_code") ?? process.env.PRINT_SHOP_CODE ?? "";
let socket: Socket | undefined;
let connected = false;
let shopName = "";
let connectionError = "";
let connectedSince: string | null = null;
let printers: ShopPrinter[] =
  store.getSetting("printers_shop_code") === shopCode ? store.listPrinters() : [];
const printerChecks = new Map<number, PrinterCheck>();
let checking: Promise<void> | undefined;
let recheckRequested = false;
const activeWorkers = new Set<string>();

type LogLevel = "info" | "warn" | "error";
type LogEntry = { id: number; time: string; level: LogLevel; message: string };
const logLimit = Number(process.env.SYSTEM_LOG_LIMIT || 1000);
const systemLog: LogEntry[] = [];
let logSequence = 0;

function log(level: LogLevel, message: string, error?: unknown): void {
  const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
  const entry = { id: ++logSequence, time: new Date().toISOString(), level, message: message + detail };
  systemLog.push(entry);
  if (systemLog.length > logLimit) systemLog.splice(0, systemLog.length - logLimit);
  const write = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
  write(`[print_client] ${entry.message}`);
  if (level === "error" && error instanceof Error && error.stack) console.error(error.stack);
}

const shortId = (id: string) => id.slice(0, 8);

function resetPrinters(): void {
  printers = [];
  printerChecks.clear();
  store.clearPrinters();
}

function tcpTarget(address: string): { host: string; port: number } {
  const target = new URL(/^tcp:\/\//i.test(address) ? address : `tcp://${address}`);
  return { host: target.hostname, port: Number(target.port || 9100) };
}

function agentUrlFor(printer: { agentUrl?: string }): string {
  return (
    printer.agentUrl ||
    process.env.WINDOWS_PRINT_AGENT_URL ||
    "http://host.docker.internal:3010"
  ).replace(/\/$/, "");
}

function printsDirectly(printer: { agentUrl?: string }): boolean {
  return process.platform === "win32" && !printer.agentUrl;
}

function shareHost(address: string): string {
  const match = /^\\\\([^\\/"]+)\\[^\\/"]+$/.exec(address.trim());
  if (!match) throw new Error(`Invalid Windows share "${address}", expected \\\\host\\printer`);
  return match[1];
}

function probePort(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client = net.createConnection({ host, port });
    client.setTimeout(checkTimeoutMs);
    client.once("connect", () => {
      client.destroy();
      resolve();
    });
    client.once("timeout", () => {
      client.destroy();
      reject(new Error(`No response from ${host}:${port}`));
    });
    client.once("error", reject);
  });
}

async function probePrinter(printer: ShopPrinter): Promise<string> {
  switch (printer.driverType) {
    case "tcp": {
      const { host, port } = tcpTarget(printer.address);
      await probePort(host, port);
      return `Port ${port} is open`;
    }
    case "usb":
      await fs.access(printer.address, fsConstants.W_OK);
      return "Device is ready";
    case "windows": {
      if (printsDirectly(printer)) {
        const host = shareHost(printer.address);
        await probePort(host, 445).catch(() => {
          throw new Error(`Windows share host ${host} is not reachable`);
        });
        return `Windows share host ${host} is reachable`;
      }
      const agentUrl = agentUrlFor(printer);
      const response = await fetch(`${agentUrl}/health`, {
        signal: AbortSignal.timeout(checkTimeoutMs),
      }).catch(() => {
        throw new Error(`Windows print agent is not reachable at ${agentUrl}`);
      });
      if (!response.ok) throw new Error(`Windows print agent returned ${response.status}`);
      return "Windows print agent is reachable";
    }
    case "virtual":
      return "Virtual printer — saves to file";
    default:
      throw new Error("Unsupported printer driver");
  }
}

function describeProbeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const messages: Record<string, string> = {
    ECONNREFUSED: "Connection refused — printer port is closed",
    EHOSTUNREACH: "Host unreachable — check the IP and network",
    ENETUNREACH: "Network unreachable",
    ENOTFOUND: "Printer host name not found",
    ETIMEDOUT: "Connection timed out",
    ENOENT: "Device not found — is the USB printer plugged in?",
    EACCES: "No permission to open the device",
    EPERM: "No permission to open the device",
  };
  if (code && messages[code]) return messages[code];
  return error instanceof Error ? error.message : "Printer check failed";
}

function reportPrinters(): void {
  if (!socket?.connected) return;
  socket.emit(
    "printers:status",
    printers
      .filter((printer) => printer.active)
      .map((printer) => {
        const check = printerChecks.get(printer.id);
        return {
          id: printer.id,
          online: check?.state === "online",
          message: check?.message || "",
          latencyMs: check?.latencyMs,
          checkedAt: check?.checkedAt,
        };
      })
      .filter((report) => printerChecks.get(report.id)?.state !== "checking")
  );
}

function setPrinterCheck(printer: ShopPrinter, check: PrinterCheck): void {
  const previous = printerChecks.get(printer.id)?.state;
  printerChecks.set(printer.id, check);
  if (previous === check.state) return;
  if (check.state === "online") log("info", `Printer ${printer.name} is online (${check.message})`);
  if (check.state === "offline") log("warn", `Printer ${printer.name} is offline: ${check.message}`);
}

function checkPrinters(): Promise<void> {
  if (checking) {
    recheckRequested = true;
    return checking;
  }
  recheckRequested = false;
  checking = (async () => {
    for (const printer of printers) {
      if (!printer.active) {
        printerChecks.set(printer.id, { state: "disabled", message: "Disabled in the portal" });
      } else if (!printerChecks.has(printer.id)) {
        printerChecks.set(printer.id, { state: "checking", message: "Checking…" });
      }
    }
    await Promise.all(
      printers
        .filter((printer) => printer.active)
        .map(async (printer) => {
          const started = Date.now();
          try {
            const message = await probePrinter(printer);
            if (printerChecks.get(printer.id)?.state === "offline" && store.retryNow(printer.name)) {
              runQueue();
            }
            setPrinterCheck(printer, {
              state: "online",
              message,
              latencyMs: Date.now() - started,
              checkedAt: new Date().toISOString(),
            });
          } catch (error) {
            setPrinterCheck(printer, {
              state: "offline",
              message: describeProbeError(error),
              checkedAt: new Date().toISOString(),
            });
          }
        })
    );
    reportPrinters();
  })().finally(() => {
    checking = undefined;
    if (recheckRequested) void checkPrinters();
  });
  return checking;
}

function recordPrintResult(job: PrintJob, online: boolean, message: string): void {
  const printer = printers.find((item) => item.name === job.printer.name && item.active);
  if (!printer) return;
  setPrinterCheck(printer, {
    state: online ? "online" : "offline",
    message,
    checkedAt: new Date().toISOString(),
  });
  reportPrinters();
}

function setPrinters(list: unknown): void {
  if (!Array.isArray(list)) return;
  const before = JSON.stringify(printers);
  printers = list
    .filter((item): item is ShopPrinter => Number.isInteger(item?.id) && typeof item?.name === "string")
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: String(item.description || ""),
      driverType: item.driverType,
      address: String(item.address || ""),
      agentUrl: String(item.agentUrl || ""),
      active: item.active === true,
    }));
  if (JSON.stringify(printers) !== before) {
    log("info", `Loaded ${printers.length} printer(s) from the shop: ${printers.map((printer) => `${printer.name} (${printer.driverType} ${printer.address}${printer.active ? "" : ", disabled"})`).join(", ") || "none"}`);
  }
  store.replacePrinters(printers);
  store.setSetting("printers_shop_code", shopCode);
  store.setSetting("printers_loaded_at", new Date().toISOString());
  const ids = new Set(printers.map((printer) => printer.id));
  for (const id of printerChecks.keys()) if (!ids.has(id)) printerChecks.delete(id);
  for (const printer of printers) {
    if (!printer.active || printerChecks.get(printer.id)?.state === "disabled") {
      printerChecks.delete(printer.id);
    }
  }
  void checkPrinters();
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const imageMarker = /^\u001bIMAGE:(\d+)\u001b$/;
const rasterBandRows = 256;

/** GS v 0 raster bit image, split into bands for printers with small receive buffers. */
function rasterCommands(image: RasterImage): Buffer[] {
  const bits = Buffer.from(image.data, "base64");
  const rowBytes = image.width / 8;
  const bands: Buffer[] = [];
  for (let top = 0; top < image.height; top += rasterBandRows) {
    const rows = Math.min(rasterBandRows, image.height - top);
    bands.push(
      Buffer.from([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8]),
      bits.subarray(top * rowBytes, (top + rows) * rowBytes)
    );
  }
  return bands;
}

/** Style flags from the portal: b = bold, d = double size, i = inverted, u = underline. */
const styleMarker = /\u001bS:([a-z]*)\u001b/;

/**
 * First line of template output when the template uses small or large text. Small is
 * font B (9-dot characters: 42 or 64 per line); large is font A at double height with
 * 4 dots of spacing (16-dot characters: 24 or 36 per line).
 */
const sizeMarker = /^\u001bSIZE:(small|normal|large)\u001b(?:\r?\n|$)/;

function sizeCommands(size: string): Buffer {
  if (size === "small") return Buffer.from([0x1b, 0x4d, 0x01]);
  if (size === "large") return Buffer.from([0x1b, 0x20, 0x04, 0x1d, 0x21, 0x01]);
  return Buffer.alloc(0);
}

function styleCommands(flags: string, size: string): Buffer {
  return Buffer.from([
    0x1b, 0x45, flags.includes("b") ? 1 : 0,
    0x1b, 0x2d, flags.includes("u") ? 1 : 0,
    0x1d, 0x21, flags.includes("d") ? 0x11 : size === "large" ? 0x01 : 0,
    0x1d, 0x42, flags.includes("i") ? 1 : 0,
  ]);
}

function buildEscPos(content: string, images: RasterImage[] = []): Buffer {
  const size = sizeMarker.exec(content)?.[1] ?? "normal";
  const parts: Buffer[] = [Buffer.from([0x1b, 0x40]), sizeCommands(size)];
  for (const line of content.replace(sizeMarker, "").replace(/\r\n/g, "\n").split("\n")) {
    const marker = imageMarker.exec(line);
    if (marker) {
      const image = images[Number(marker[1])];
      if (image) parts.push(...rasterCommands(image));
      continue;
    }
    let styled = false;
    line.split(styleMarker).forEach((part, index) => {
      if (index % 2 === 1) {
        parts.push(styleCommands(part, size));
        styled = part.length > 0;
      } else if (part) {
        parts.push(Buffer.from(part, "utf8"));
      }
    });
    parts.push(Buffer.from("\n"));
    if (styled) parts.push(styleCommands("", size));
  }
  parts.push(cutCommands());
  return Buffer.concat(parts);
}

/**
 * The cutter sits a few lines above the print head, so the paper must be fed past it
 * before cutting or the last lines end up on the next receipt.
 */
const cutFeedLines = Math.min(
  255,
  Math.max(0, Math.trunc(Number(process.env.PRINT_CUT_FEED_LINES ?? 6)) || 0)
);
const cutMode = process.env.PRINT_CUT_MODE === "partial" ? 0x01 : 0x00;

function cutCommands(): Buffer {
  return Buffer.from([0x1b, 0x64, cutFeedLines, 0x1d, 0x56, cutMode]);
}

function writeTcp(address: string, data: Buffer): Promise<void> {
  const target = tcpTarget(address);
  return new Promise((resolve, reject) => {
    const client = net.createConnection(target);
    client.setTimeout(Number(process.env.PRINTER_TIMEOUT_MS || 10_000));
    client.once("connect", () => client.end(data));
    client.once("timeout", () =>
      client.destroy(new Error("Network printer timed out"))
    );
    client.once("error", reject);
    client.once("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
}

async function writeUsb(devicePath: string, data: Buffer): Promise<void> {
  const handle = await fs.open(devicePath, "w");
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
}

async function writeWindowsShare(address: string, data: Buffer): Promise<void> {
  const share = address.trim();
  shareHost(share);
  const tempFile = path.join(os.tmpdir(), `print-client-${randomUUID()}.bin`);
  await fs.writeFile(tempFile, data);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "cmd.exe",
        ["/d", "/s", "/c", `"copy /b "${tempFile}" "${share}""`],
        {
          windowsVerbatimArguments: true,
          windowsHide: true,
          timeout: Number(process.env.PRINTER_TIMEOUT_MS || 10_000),
        },
        (error, stdout, stderr) => {
          if (!error) return resolve();
          const detail = `${stdout}\n${stderr}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !/file\(s\) copied/i.test(line))
            .join(" ");
          reject(new Error(`Printing to ${share} failed: ${detail || error.message}`));
        }
      );
    });
  } finally {
    await fs.rm(tempFile, { force: true });
  }
}

async function writeWindowsAgent(job: PrintJob, data: Buffer): Promise<void> {
  const agentUrl = agentUrlFor(job.printer);
  const response = await fetch(`${agentUrl}/print`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: job.printer.address,
      data: data.toString("base64"),
      encoding: "base64",
    }),
    signal: AbortSignal.timeout(
      Number(process.env.PRINTER_TIMEOUT_MS || 10_000)
    ),
  }).catch((error: unknown) => {
    throw new Error(
      `Windows print agent is not reachable at ${agentUrl} (${error instanceof Error ? error.message : String(error)})`
    );
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(result.error || `Windows print agent returned ${response.status}`);
  }
}

async function printJob(job: PrintJob): Promise<number> {
  const data = buildEscPos(job.content, job.images);
  switch (job.printer.driverType) {
    case "tcp":
      await writeTcp(job.printer.address, data);
      break;
    case "usb":
      await writeUsb(job.printer.address, data);
      break;
    case "windows":
      if (printsDirectly(job.printer)) await writeWindowsShare(job.printer.address, data);
      else await writeWindowsAgent(job, data);
      break;
    case "virtual": {
      const outputDirectory = path.join(dataDirectory, "printed");
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(path.join(outputDirectory, `${job.id}.bin`), data);
      break;
    }
    default:
      throw new Error("Unsupported printer driver");
  }
  return data.length;
}

function sendAck(ack: { id: string; status: string; message: string; bytes?: number }): void {
  if (!socket?.connected) return;
  socket
    .timeout(ackTimeoutMs)
    .emit(
      "print:ack",
      {
        jobId: ack.id,
        success: ack.status === "completed",
        bytes: ack.bytes ?? 0,
        error: ack.status === "completed" ? undefined : ack.message,
      },
      (error: Error | null, reply?: { ok?: boolean }) => {
        if (!error && reply?.ok) store.markAcked(ack.id);
      }
    );
}

function flushAcks(): void {
  for (const ack of store.unacked()) sendAck(ack);
}

function retryDelayMs(attempt: number): number {
  return Math.min(retry.baseDelayMs * 2 ** Math.max(0, attempt - 1), retry.maxDelayMs);
}

function sendRetrying(id: string, message: string): void {
  socket?.emit("print:retrying", { jobId: id, message });
}

async function processJob(job: PrintJob & { attempt: number }): Promise<void> {
  const started = Date.now();
  try {
    const bytes = await printJob(job);
    store.finish(job.id, {
      status: "completed",
      message: job.attempt > 1 ? `Printed on attempt ${job.attempt}` : "Printed",
      bytes,
      durationMs: Date.now() - started,
    });
    recordPrintResult(job, true, "Last print succeeded");
    log("info", `Printed job ${shortId(job.id)} on ${job.printer.name} (${bytes} bytes, ${Date.now() - started} ms${job.attempt > 1 ? `, attempt ${job.attempt}` : ""})`);
    sendAck({ id: job.id, status: "completed", message: "Printed", bytes });
    store.retryNow(job.printer.name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Print failed";
    recordPrintResult(job, false, describeProbeError(error));
    if (retry.maxAttempts === 0 || job.attempt < retry.maxAttempts) {
      const nextRetryAt = new Date(Date.now() + retryDelayMs(job.attempt)).toISOString();
      const limit = retry.maxAttempts ? `/${retry.maxAttempts}` : "";
      const message = `Attempt ${job.attempt}${limit} failed: ${reason}`;
      store.scheduleRetry(job.id, { message, durationMs: Date.now() - started, nextRetryAt });
      log("warn", `Job ${shortId(job.id)} on ${job.printer.name}: ${message} — next retry at ${new Date(nextRetryAt).toLocaleTimeString()}`);
      sendRetrying(job.id, `${message} — retrying automatically`);
      return;
    }
    const message = `Gave up after ${job.attempt} attempts: ${reason}`;
    store.finish(job.id, { status: "failed", message, durationMs: Date.now() - started });
    log("error", `Job ${shortId(job.id)} on ${job.printer.name}: ${message}`);
    sendAck({ id: job.id, status: "failed", message });
  }
}

function runQueue(): void {
  for (const printerName of store.waitingPrinters()) {
    if (activeWorkers.has(printerName)) continue;
    activeWorkers.add(printerName);
    void (async () => {
      try {
        for (let job = store.claimNext(printerName); job; job = store.claimNext(printerName)) {
          await processJob(job);
        }
      } catch (error) {
        log("error", `Queue worker for ${printerName} failed`, error);
      } finally {
        activeWorkers.delete(printerName);
        store.prune();
      }
    })();
  }
}

function receiveJob(job: PrintJob): void {
  const result = store.receiveJob(job);
  log("info", `Received job ${shortId(job.id)} for ${job.printer?.name ?? "unknown printer"}${result === "duplicate" ? " (already printed, confirming again)" : result === "in-queue" ? " (already in queue)" : ""}`);
  if (result === "duplicate") {
    const record = store.getJob(job.id);
    sendAck({ id: job.id, status: "completed", message: "Printed", bytes: record?.bytes });
    return;
  }
  if (result === "in-queue") {
    const record = store.getJob(job.id);
    if (record?.nextRetryAt) sendRetrying(job.id, `${record.message} — retrying automatically`);
  }
  runQueue();
}

function connectSocket(): void {
  socket?.disconnect();
  connected = false;
  connectedSince = null;
  shopName = "";
  if (!shopCode) {
    log("warn", "No shop pairing code — not connecting to Print Service");
    return;
  }

  log("info", `Connecting to Print Service at ${serviceUrl}`);
  socket = io(serviceUrl, {
    auth: { shopCode },
    reconnection: true,
    transports: ["websocket", "polling"],
  });
  socket.on("connect", () => {
    connected = true;
    connectedSince = new Date().toISOString();
    connectionError = "";
    log("info", "Connected to Print Service");
    flushAcks();
  });
  socket.on("shop:ready", (shop: { shopName: string }) => {
    shopName = shop.shopName;
    log("info", `Paired with shop ${shopName}`);
  });
  socket.on("connect_error", (error) => {
    connected = false;
    connectedSince = null;
    if (connectionError !== error.message) log("warn", "Cannot connect to Print Service", error);
    connectionError = error.message;
  });
  socket.on("disconnect", (reason) => {
    connected = false;
    connectedSince = null;
    log("warn", `Disconnected from Print Service (${reason})`);
  });
  socket.on("client:replaced", (event: { message?: string }) => {
    connectionError = event.message || "Client replaced";
    log("warn", connectionError);
  });
  socket.on("print:job", (job: PrintJob) => receiveJob({ ...job, images: validImages(job?.images) }));
  socket.on("printers:list", (list: unknown) => setPrinters(list));
}

function statusPayload() {
  const counts = store.counts();
  return {
    connected,
    paired: Boolean(shopCode),
    shopName,
    connectionError,
    connectedSince,
    serviceUrl,
    counts,
    retry,
    jobs: store.listJobs(listLimit),
    storage: {
      engine: "SQLite",
      file: store.file,
      sizeBytes: store.sizeBytes(),
      totalJobs: counts.total,
      unacked: store.unacked().length,
    },
    printersLoadedAt: store.getSetting("printers_loaded_at") ?? null,
    printers: printers.map((printer) => ({
      ...printer,
      ...(printerChecks.get(printer.id) ||
        (printer.active
          ? { state: "checking", message: "Checking…" }
          : { state: "disabled", message: "Disabled in the portal" })),
    })),
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 100_000) throw new Error("Request is too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const assets: Record<string, { type: string; file: string }> = {
  "/assets/app.css": { type: "text/css; charset=utf-8", file: "app.css" },
  "/assets/app.js": { type: "text/javascript; charset=utf-8", file: "app.js" },
};

function assetVersion(file: string): string {
  try {
    return createHash("sha1")
      .update(readFileSync(path.join(publicDirectory, file)))
      .digest("hex")
      .slice(0, 10);
  } catch {
    return String(Date.now());
  }
}

const cssUrl = `/assets/app.css?v=${assetVersion("app.css")}`;
const jsUrl = `/assets/app.js?v=${assetVersion("app.js")}`;

function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Print Client${shopName ? ` · ${esc(shopName)}` : ""}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
  <link rel="stylesheet" href="${cssUrl}">
  <script src="${jsUrl}" defer></script>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg></span>
      <span class="brand-text"><strong>Print Client</strong><small data-bind="shop">${esc(shopName || "Not paired")}</small></span>
    </div>
    <div class="topbar-actions">
      <button type="button" class="btn btn-ghost" data-logs>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>
        Logs
      </button>
      <span class="conn" data-bind="conn"><span class="conn-dot"></span><span data-bind="connText">Loading…</span></span>
    </div>
  </header>

  <main class="content">
    <section class="stats">
      <article class="stat stat-blue"><span>In queue</span><strong data-count="active">0</strong><small>Waiting or printing</small></article>
      <article class="stat stat-amber"><span>Retrying</span><strong data-count="retrying">0</strong><small>Failed — retrying automatically</small></article>
      <article class="stat stat-green"><span>Printed</span><strong data-count="printed24h">0</strong><small>Last 24 hours · removed from queue</small></article>
      <article class="stat stat-red"><span>Failed</span><strong data-count="failed">0</strong><small>Gave up — needs a manual retry</small></article>
    </section>

    <section class="layout">
      <div class="main">
      <article class="card">
        <header class="card-header">
          <div><h2>Printers</h2><p data-bind="printersSummary">Loaded from the shop in Print Service.</p></div>
          <button type="button" class="btn btn-ghost" data-check>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
            Check now
          </button>
        </header>
        <div class="printer-grid" data-bind="printers"></div>
        <div class="empty empty-sm" data-bind="printersEmpty" hidden>
          <strong>No printers in this shop</strong><p>Add printers for this shop in the Print Service portal.</p>
        </div>
      </article>

      <article class="card jobs-card">
        <header class="card-header">
          <div><h2>Print queue</h2><p data-bind="queueHint">Printed jobs are removed automatically; failed jobs retry on their own.</p></div>
          <form method="post" action="/history/clear" data-clear><button type="submit" class="btn btn-ghost">Clear failed</button></form>
        </header>
        <div class="toolbar">
          <div class="tabs" role="tablist">
            <button type="button" class="tab active" data-filter="all">All <span data-count="total">0</span></button>
            <button type="button" class="tab" data-filter="active">In queue <span data-count="active">0</span></button>
            <button type="button" class="tab" data-filter="retrying">Retrying <span data-count="retrying">0</span></button>
            <button type="button" class="tab" data-filter="failed">Failed <span data-count="failed">0</span></button>
          </div>
          <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input type="search" placeholder="Search printer, text, ID…" data-search></label>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th class="col-time">Received</th><th>Receipt</th><th class="col-status">Status</th><th class="col-actions"></th></tr></thead>
            <tbody data-bind="rows"></tbody>
          </table>
        </div>
        <div class="empty" data-bind="empty" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6"/></svg>
          <strong>Queue is empty</strong><p>New jobs appear here instantly and disappear once printed.</p>
        </div>
      </article>
      </div>

      <aside class="side">
        <article class="card">
          <header class="card-header"><div><h2>Connection</h2><p>Socket.IO link to Print Service.</p></div></header>
          <dl class="details">
            <div><dt>Status</dt><dd data-bind="connBadge">—</dd></div>
            <div><dt>Shop</dt><dd data-bind="shopName">—</dd></div>
            <div><dt>Connected</dt><dd data-bind="since">—</dd></div>
            <div><dt>Service</dt><dd class="mono">${esc(serviceUrl)}</dd></div>
            <div><dt>Queue</dt><dd data-bind="queue">—</dd></div>
            <div><dt>Storage</dt><dd data-bind="storage">—</dd></div>
          </dl>
        </article>
        <article class="card">
          <header class="card-header"><div><h2>Shop pairing</h2><p>Paste the pairing code from the portal's Shops page.</p></div></header>
          <form method="post" action="/configure" class="pair-form">
            <input name="shopCode" value="${esc(shopCode)}" placeholder="SHOP-PAIRING-CODE" autocomplete="off" required>
            <button type="submit" class="btn btn-primary">Save and connect</button>
          </form>
        </article>
      </aside>
    </section>
  </main>

  <dialog class="dialog" data-bind="dialog">
    <form method="dialog" class="dialog-head"><h2 data-bind="dTitle">Receipt</h2><button class="icon-btn" aria-label="Close">✕</button></form>
    <div class="dialog-body">
      <div class="paper"><pre data-bind="dContent"></pre></div>
      <dl class="details" data-bind="dDetails"></dl>
    </div>
    <div class="dialog-foot"><button type="button" class="btn btn-danger-ghost" data-bind="dRemove" hidden>Remove job</button><button type="button" class="btn btn-primary" data-bind="dRetry" hidden>Retry now</button></div>
  </dialog>

  <dialog class="dialog dialog-wide" data-bind="logDialog">
    <form method="dialog" class="dialog-head"><h2>System log</h2><button class="icon-btn" aria-label="Close">✕</button></form>
    <div class="log-toolbar">
      <div class="tabs" role="tablist">
        <button type="button" class="tab active" data-log-level="all">All <span data-log-count="all">0</span></button>
        <button type="button" class="tab" data-log-level="warn">Warnings <span data-log-count="warn">0</span></button>
        <button type="button" class="tab" data-log-level="error">Errors <span data-log-count="error">0</span></button>
      </div>
      <a class="btn btn-ghost btn-sm" href="/logs.txt" download>Download</a>
    </div>
    <div class="log-list" data-bind="logList"></div>
    <p class="log-hint" data-bind="logHint"></p>
  </dialog>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(renderPage());
      return;
    }
    const asset = request.method === "GET" ? assets[url.pathname] : undefined;
    if (asset) {
      response.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "public, max-age=86400",
      });
      response.end(await fs.readFile(path.join(publicDirectory, asset.file)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "print_client",
        connected,
        shop: shopName || null,
        paired: Boolean(shopCode),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, statusPayload());
      return;
    }
    if (request.method === "GET" && url.pathname === "/logs") {
      sendJson(response, 200, { limit: logLimit, entries: systemLog });
      return;
    }
    if (request.method === "GET" && url.pathname === "/logs.txt") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="print-client-log-${new Date().toISOString().slice(0, 10)}.txt"`,
        "cache-control": "no-store",
      });
      response.end(systemLog.map((entry) => `${entry.time} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`).join("\r\n"));
      return;
    }
    const removeMatch = url.pathname.match(/^\/jobs\/([\w-]+)\/remove$/);
    if (request.method === "POST" && removeMatch) {
      const entry = store.getJob(removeMatch[1]);
      if (!entry) {
        sendJson(response, 404, { error: "Job not found" });
        return;
      }
      if (entry.status === "printing" || !store.remove(entry.id)) {
        sendJson(response, 409, { error: "Job is printing right now" });
        return;
      }
      if (!entry.acked) {
        sendAck({ id: entry.id, status: "failed", message: "Removed on the Print Client" });
      }
      log("info", `Job ${shortId(entry.id)} removed by user`);
      sendJson(response, 200, { id: entry.id, removed: true });
      return;
    }
    const jobMatch = url.pathname.match(/^\/jobs\/([\w-]+)(\/retry)?$/);
    if (jobMatch) {
      const entry = store.getJob(jobMatch[1]);
      if (!entry) {
        sendJson(response, 404, { error: "Job not found" });
        return;
      }
      if (request.method === "GET" && !jobMatch[2]) {
        sendJson(response, 200, entry);
        return;
      }
      if (request.method === "POST" && jobMatch[2]) {
        if (!store.requeue(entry.id)) {
          sendJson(response, 409, { error: "Job is already in progress" });
          return;
        }
        log("info", `Job ${shortId(entry.id)} retried by user`);
        runQueue();
        sendJson(response, 202, { id: entry.id, status: "waiting" });
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/printers/check") {
      if (socket?.connected) {
        const refreshed = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          socket?.once("printers:list", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        socket.emit("printers:refresh");
        await refreshed;
      }
      await checkPrinters();
      if (checking) await checking;
      sendJson(response, 200, statusPayload());
      return;
    }
    if (request.method === "POST" && url.pathname === "/history/clear") {
      store.clearFailed();
      log("info", "Failed jobs cleared by user");
      response.writeHead(303, { location: "/" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/configure") {
      const form = await readForm(request);
      const nextCode = String(form.get("shopCode") || "").trim();
      if (nextCode !== shopCode) {
        resetPrinters();
        log("info", "Shop pairing code changed");
      }
      shopCode = nextCode;
      store.setSetting("shop_code", shopCode);
      connectSocket();
      response.writeHead(303, { location: "/" });
      response.end();
      return;
    }
    sendJson(response, 404, { error: "Route not found" });
  } catch (error) {
    log("error", `Request ${request.method} ${request.url} failed`, error);
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Client error",
    });
  }
});

function start(): void {
  const interrupted = store.recoverInterrupted();
  if (interrupted) {
    log("warn", `${interrupted} job(s) interrupted by restart marked as failed`);
  }
  log("info", `Print Client starting on ${os.hostname()} (${process.platform}, Node ${process.version})`);
  log("info", `SQLite store at ${store.file}`);
  connectSocket();
  runQueue();
  setInterval(runQueue, 1_000).unref();
  setInterval(() => store.prune(), 3_600_000).unref();
  void checkPrinters();
  setInterval(() => void checkPrinters(), checkIntervalMs).unref();
  server.listen(port, "0.0.0.0", () => {
    log("info", `Listening on port ${port}`);
  });
}

function shutdown(): void {
  socket?.disconnect();
  server.close();
  store.close();
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

start();
