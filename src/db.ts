import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type DriverType = "tcp" | "usb" | "windows" | "virtual";
export type JobStatus = "waiting" | "printing" | "completed" | "failed";

/** 1-bit raster: rows of `width / 8` bytes, most significant bit first, 1 = black. */
export type RasterImage = { width: number; height: number; data: string };

export type PrintJob = {
  id: string;
  content: string;
  images?: RasterImage[];
  printer: {
    name: string;
    driverType: DriverType;
    address: string;
    agentUrl?: string;
  };
};

export type JobRecord = {
  id: string;
  printer: string;
  driverType: DriverType;
  address: string;
  agentUrl: string;
  status: JobStatus;
  message: string;
  attempts: number;
  deliveries: number;
  bytes?: number;
  receivedAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  preview: string;
  acked: boolean;
  nextRetryAt?: string;
};

export type ShopPrinter = {
  id: number;
  name: string;
  description: string;
  driverType: DriverType;
  address: string;
  agentUrl: string;
  active: boolean;
};

export type ReceiveResult = "queued" | "requeued" | "in-queue" | "duplicate";

type Row = Record<string, unknown>;

const schema = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    printer_name TEXT NOT NULL,
    driver_type TEXT NOT NULL,
    address TEXT NOT NULL,
    agent_url TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('waiting', 'printing', 'completed', 'failed')),
    message TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    deliveries INTEGER NOT NULL DEFAULT 1,
    bytes INTEGER,
    received_at TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    acked INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (status, printer_name, queued_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_received ON jobs (received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_unacked ON jobs (acked, status);

  CREATE TABLE IF NOT EXISTS printed_jobs (
    id TEXT PRIMARY KEY,
    printer_name TEXT NOT NULL,
    bytes INTEGER,
    printed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_printed_at ON printed_jobs (printed_at);

  CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    driver_type TEXT NOT NULL,
    address TEXT NOT NULL,
    agent_url TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );
`;

const jobColumns = `id, printer_name, driver_type, address, agent_url, preview, status, message,
  attempts, deliveries, bytes, received_at, queued_at, started_at, finished_at, duration_ms, acked,
  next_retry_at`;

const now = () => new Date().toISOString();
const optional = <T>(value: unknown): T | undefined =>
  value === null || value === undefined ? undefined : (value as T);

function toJob(row: Row): JobRecord {
  return {
    id: String(row.id),
    printer: String(row.printer_name),
    driverType: row.driver_type as DriverType,
    address: String(row.address),
    agentUrl: String(row.agent_url || ""),
    status: row.status as JobStatus,
    message: String(row.message || ""),
    attempts: Number(row.attempts),
    deliveries: Number(row.deliveries),
    bytes: optional<number>(row.bytes),
    receivedAt: String(row.received_at),
    queuedAt: String(row.queued_at),
    startedAt: optional<string>(row.started_at),
    finishedAt: optional<string>(row.finished_at),
    durationMs: optional<number>(row.duration_ms),
    preview: String(row.preview || ""),
    acked: Number(row.acked) === 1,
    nextRetryAt: optional<string>(row.next_retry_at),
  };
}

function preview(content: string): string {
  return content
    .replace(/^\u001bSIZE:[a-z]+\u001b/, "")
    .replace(/\u001bIMAGE:\d+\u001b/g, "[image]")
    .replace(/\u001bS:[a-z]*\u001b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

const maxImageDots = 1024;
const maxImageRows = 20_000;

/** Keeps only well-formed raster images; anything else from the wire is dropped. */
export function validImages(images: unknown): RasterImage[] {
  if (!Array.isArray(images)) return [];
  return images.slice(0, 8).filter((image): image is RasterImage => {
    const { width, height, data } = (image ?? {}) as Partial<RasterImage>;
    return (
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width! > 0 &&
      width! <= maxImageDots &&
      width! % 8 === 0 &&
      height! > 0 &&
      height! <= maxImageRows &&
      typeof data === "string" &&
      Buffer.from(data, "base64").length === (width! / 8) * height!
    );
  });
}

function imagesJson(job: PrintJob): string | null {
  const images = validImages(job.images);
  return images.length ? JSON.stringify(images) : null;
}

function parseImages(raw: unknown): RasterImage[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    return validImages(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function openStore(
  dataDirectory: string,
  options: { historyLimit: number; printedRetentionDays: number }
) {
  mkdirSync(dataDirectory, { recursive: true });
  const file = path.join(dataDirectory, "print-client.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  const jobTableColumns = (db.prepare("PRAGMA table_info(jobs)").all() as Row[]).map((row) =>
    String(row.name)
  );
  if (!jobTableColumns.includes("next_retry_at")) {
    db.exec("ALTER TABLE jobs ADD COLUMN next_retry_at TEXT");
  }
  if (!jobTableColumns.includes("images")) {
    db.exec("ALTER TABLE jobs ADD COLUMN images TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, next_retry_at)");

  const all = (sql: string, ...params: SQLInputValue[]) =>
    db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: SQLInputValue[]) =>
    db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) =>
    Number(db.prepare(sql).run(...params).changes);

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getSetting(key: string): string | undefined {
    return optional<string>(get("SELECT value FROM settings WHERE key = ?", key)?.value);
  }

  function setSetting(key: string, value: string | null): void {
    if (value === null) run("DELETE FROM settings WHERE key = ?", key);
    else {
      run(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value
      );
    }
  }

  function replacePrinters(printers: ShopPrinter[]): void {
    transaction(() => {
      run("DELETE FROM printers");
      const insert = db.prepare(
        `INSERT INTO printers (id, name, description, driver_type, address, agent_url, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const printer of printers) {
        insert.run(
          printer.id,
          printer.name,
          printer.description,
          printer.driverType,
          printer.address,
          printer.agentUrl,
          printer.active ? 1 : 0
        );
      }
    });
  }

  function listPrinters(): ShopPrinter[] {
    return all("SELECT * FROM printers ORDER BY name").map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      description: String(row.description || ""),
      driverType: row.driver_type as DriverType,
      address: String(row.address),
      agentUrl: String(row.agent_url || ""),
      active: Number(row.active) === 1,
    }));
  }

  function migrateJsonFiles(): void {
    const configPath = path.join(dataDirectory, "client-config.json");
    const historyPath = path.join(dataDirectory, "print-history.json");
    const printersPath = path.join(dataDirectory, "printers.json");
    const readJson = (target: string): unknown => {
      try {
        return JSON.parse(readFileSync(target, "utf8"));
      } catch {
        return undefined;
      }
    };
    const retire = (target: string) => {
      if (existsSync(target)) renameSync(target, `${target}.migrated`);
    };

    if (existsSync(configPath)) {
      const saved = readJson(configPath) as { shopCode?: string } | undefined;
      if (saved?.shopCode && !getSetting("shop_code")) setSetting("shop_code", saved.shopCode);
      retire(configPath);
    }

    if (existsSync(historyPath)) {
      const saved = readJson(historyPath);
      if (Array.isArray(saved)) {
        transaction(() => {
          const insert = db.prepare(
            `INSERT OR IGNORE INTO jobs
              (id, printer_name, driver_type, address, agent_url, content, preview, status, message,
               attempts, bytes, received_at, queued_at, started_at, finished_at, duration_ms, acked)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
          );
          for (const entry of saved as Row[]) {
            const job = entry.job as PrintJob | undefined;
            if (!job?.id || typeof job.content !== "string") continue;
            const oldStatus = String(entry.status);
            const status = oldStatus === "completed" || oldStatus === "skipped" ? "completed" : "failed";
            const receivedAt = String(entry.receivedAt || now());
            insert.run(
              job.id,
              job.printer.name,
              job.printer.driverType,
              job.printer.address,
              job.printer.agentUrl || "",
              job.content,
              preview(job.content),
              status,
              status === "failed" && oldStatus !== "failed"
                ? "Interrupted by a client restart"
                : String(entry.message || ""),
              Number(entry.attempts || 0),
              optional<number>(entry.bytes) ?? null,
              receivedAt,
              receivedAt,
              optional<string>(entry.startedAt) ?? null,
              optional<string>(entry.finishedAt) ?? receivedAt,
              optional<number>(entry.durationMs) ?? null
            );
          }
        });
      }
      retire(historyPath);
    }

    if (existsSync(printersPath)) {
      const saved = readJson(printersPath) as
        | { shopCode?: string; loadedAt?: string; printers?: ShopPrinter[] }
        | undefined;
      if (Array.isArray(saved?.printers) && saved.shopCode === getSetting("shop_code")) {
        replacePrinters(saved.printers);
        setSetting("printers_shop_code", saved.shopCode || "");
        if (saved.loadedAt) setSetting("printers_loaded_at", saved.loadedAt);
      }
      retire(printersPath);
    }
  }

  function archivePrinted(where: string, ...params: SQLInputValue[]): number {
    return transaction(() => {
      run(
        `INSERT OR IGNORE INTO printed_jobs (id, printer_name, bytes, printed_at)
         SELECT id, printer_name, bytes, COALESCE(finished_at, received_at) FROM jobs
         WHERE status = 'completed' AND acked = 1 AND ${where}`,
        ...params
      );
      return run(`DELETE FROM jobs WHERE status = 'completed' AND acked = 1 AND ${where}`, ...params);
    });
  }

  const dueClause = "status = 'waiting' AND (next_retry_at IS NULL OR next_retry_at <= ?)";

  migrateJsonFiles();
  archivePrinted("1 = 1");

  return {
    file,
    getSetting,
    setSetting,
    replacePrinters,
    listPrinters,

    clearPrinters(): void {
      run("DELETE FROM printers");
      setSetting("printers_loaded_at", null);
      setSetting("printers_shop_code", null);
    },

    receiveJob(job: PrintJob): ReceiveResult {
      return transaction(() => {
        if (get("SELECT 1 AS found FROM printed_jobs WHERE id = ?", job.id)) return "duplicate";
        const existing = get("SELECT status FROM jobs WHERE id = ?", job.id);
        const timestamp = now();
        if (!existing) {
          run(
            `INSERT INTO jobs
              (id, printer_name, driver_type, address, agent_url, content, images, preview, status,
               message, received_at, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 'Waiting in queue', ?, ?)`,
            job.id,
            job.printer.name,
            job.printer.driverType,
            job.printer.address,
            job.printer.agentUrl || "",
            job.content,
            imagesJson(job),
            preview(job.content),
            timestamp,
            timestamp
          );
          return "queued";
        }
        if (existing.status === "completed") {
          run(
            `UPDATE jobs SET deliveries = deliveries + 1, acked = 0,
                    message = 'Printed — duplicate delivery ignored'
             WHERE id = ?`,
            job.id
          );
          return "duplicate";
        }
        if (existing.status === "waiting" || existing.status === "printing") {
          run("UPDATE jobs SET deliveries = deliveries + 1 WHERE id = ?", job.id);
          return "in-queue";
        }
        run(
          `UPDATE jobs SET printer_name = ?, driver_type = ?, address = ?, agent_url = ?,
                  content = ?, images = ?, preview = ?, status = 'waiting', message = 'Waiting in queue',
                  deliveries = deliveries + 1, queued_at = ?, finished_at = NULL,
                  duration_ms = NULL, acked = 0, attempts = 0, next_retry_at = NULL
           WHERE id = ?`,
          job.printer.name,
          job.printer.driverType,
          job.printer.address,
          job.printer.agentUrl || "",
          job.content,
          imagesJson(job),
          preview(job.content),
          timestamp,
          job.id
        );
        return "requeued";
      });
    },

    requeue(id: string): boolean {
      return (
        run(
          `UPDATE jobs SET status = 'waiting', message = 'Waiting in queue', queued_at = ?,
                  finished_at = NULL, duration_ms = NULL, acked = 0, attempts = 0, next_retry_at = NULL
           WHERE id = ? AND (status = 'failed' OR (status = 'waiting' AND next_retry_at IS NOT NULL))`,
          now(),
          id
        ) === 1
      );
    },

    retryNow(printerName: string): number {
      return run(
        `UPDATE jobs SET next_retry_at = ?
         WHERE status = 'waiting' AND printer_name = ? AND next_retry_at > ?`,
        now(),
        printerName,
        now()
      );
    },

    scheduleRetry(id: string, result: { message: string; durationMs: number; nextRetryAt: string }): void {
      run(
        `UPDATE jobs SET status = 'waiting', message = ?, finished_at = ?, duration_ms = ?,
                next_retry_at = ?
         WHERE id = ?`,
        result.message,
        now(),
        result.durationMs,
        result.nextRetryAt,
        id
      );
    },

    waitingPrinters(): string[] {
      return all(`SELECT DISTINCT printer_name FROM jobs WHERE ${dueClause}`, now()).map((row) =>
        String(row.printer_name)
      );
    },

    claimNext(printerName: string): (PrintJob & { attempt: number }) | undefined {
      return transaction(() => {
        const row = get(
          `SELECT id, printer_name, driver_type, address, agent_url, content, images, attempts FROM jobs
           WHERE ${dueClause} AND printer_name = ?
           ORDER BY queued_at, rowid LIMIT 1`,
          now(),
          printerName
        );
        if (!row) return undefined;
        run(
          `UPDATE jobs SET status = 'printing', message = 'Sending to printer…',
                  attempts = attempts + 1, started_at = ?, next_retry_at = NULL
           WHERE id = ?`,
          now(),
          String(row.id)
        );
        return {
          id: String(row.id),
          attempt: Number(row.attempts) + 1,
          content: String(row.content),
          images: parseImages(row.images),
          printer: {
            name: String(row.printer_name),
            driverType: row.driver_type as DriverType,
            address: String(row.address),
            agentUrl: String(row.agent_url || ""),
          },
        };
      });
    },

    finish(
      id: string,
      result: { status: "completed" | "failed"; message: string; bytes?: number; durationMs: number }
    ): void {
      run(
        `UPDATE jobs SET status = ?, message = ?, bytes = ?, finished_at = ?, duration_ms = ?, acked = 0
         WHERE id = ?`,
        result.status,
        result.message,
        result.bytes ?? null,
        now(),
        result.durationMs,
        id
      );
    },

    markAcked(id: string): void {
      run("UPDATE jobs SET acked = 1 WHERE id = ? AND status IN ('completed', 'failed')", id);
      archivePrinted("id = ?", id);
    },

    unacked(limit = 200): { id: string; status: JobStatus; message: string; bytes?: number }[] {
      return all(
        `SELECT id, status, message, bytes FROM jobs
         WHERE acked = 0 AND status IN ('completed', 'failed')
         ORDER BY finished_at LIMIT ?`,
        limit
      ).map((row) => ({
        id: String(row.id),
        status: row.status as JobStatus,
        message: String(row.message || ""),
        bytes: optional<number>(row.bytes),
      }));
    },

    recoverInterrupted(): number {
      return run(
        `UPDATE jobs SET status = 'failed', message = 'Interrupted by a client restart — retry to print',
                finished_at = ?, acked = 0
         WHERE status = 'printing'`,
        now()
      );
    },

    listJobs(limit: number): JobRecord[] {
      return all(
        `SELECT ${jobColumns} FROM jobs ORDER BY received_at DESC, rowid DESC LIMIT ?`,
        limit
      ).map(toJob);
    },

    getJob(id: string): (JobRecord & { content: string }) | undefined {
      const row = get(`SELECT ${jobColumns}, content FROM jobs WHERE id = ?`, id);
      return row ? { ...toJob(row), content: String(row.content) } : undefined;
    },

    counts() {
      const counts = { total: 0, waiting: 0, retrying: 0, printing: 0, completed: 0, failed: 0, printed24h: 0 };
      for (const row of all(
        `SELECT CASE WHEN status = 'waiting' AND next_retry_at IS NOT NULL THEN 'retrying' ELSE status END AS state,
                COUNT(*) AS count
         FROM jobs GROUP BY state`
      )) {
        counts[row.state as keyof typeof counts] = Number(row.count);
        counts.total += Number(row.count);
      }
      const since = new Date(Date.now() - 86_400_000).toISOString();
      counts.printed24h =
        Number(get("SELECT COUNT(*) AS count FROM printed_jobs WHERE printed_at >= ?", since)?.count) +
        counts.completed;
      return counts;
    },

    remove(id: string): boolean {
      return run("DELETE FROM jobs WHERE id = ? AND status <> 'printing'", id) === 1;
    },

    clearFailed(): number {
      return run("DELETE FROM jobs WHERE status = 'failed' AND acked = 1");
    },

    prune(): number {
      const cutoff = new Date(Date.now() - options.printedRetentionDays * 86_400_000).toISOString();
      return (
        run("DELETE FROM printed_jobs WHERE printed_at < ?", cutoff) +
        run(
          `DELETE FROM jobs
           WHERE status = 'failed' AND acked = 1
             AND id NOT IN (SELECT id FROM jobs ORDER BY received_at DESC LIMIT ?)`,
          options.historyLimit
        )
      );
    },

    sizeBytes(): number {
      return [file, `${file}-wal`].reduce((total, target) => {
        try {
          return total + statSync(target).size;
        } catch {
          return total;
        }
      }, 0);
    },

    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
