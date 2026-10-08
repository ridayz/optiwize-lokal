import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8932;
const now = () => new Date().toISOString();

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(path.join(DIR, "data.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT, host TEXT, username TEXT, pass_enc TEXT, api_port INTEGER DEFAULT 80, mode TEXT DEFAULT 'demo', tags TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, device_id TEXT, ts TEXT, kind TEXT, content TEXT, size INTEGER, hash TEXT);
CREATE TABLE IF NOT EXISTS monitor(id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, ts TEXT, reachable INTEGER, latency_ms INTEGER, cpu INTEGER, mem_pct INTEGER, uptime_s INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY, name TEXT, body TEXT, vars TEXT DEFAULT '{}', updated_at TEXT);
CREATE TABLE IF NOT EXISTS applies(id INTEGER PRIMARY KEY AUTOINCREMENT, template_id TEXT, device_id TEXT, ts TEXT, status TEXT, log TEXT);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, ts TEXT, level TEXT, msg TEXT, ack INTEGER DEFAULT 0);`);

// Add bandwidth columns to monitor table (if they don't exist)
try {
  db.prepare("ALTER TABLE monitor ADD COLUMN rx_bytes BIGINT").run();
} catch (e) {
  // column likely exists
}
try {
  db.prepare("ALTER TABLE monitor ADD COLUMN tx_bytes BIGINT").run();
} catch (e) {}
try {
  db.prepare("ALTER TABLE monitor ADD COLUMN rx_mbps REAL").run();
} catch (e) {}
try {
  db.prepare("ALTER TABLE monitor ADD COLUMN tx_mbps REAL").run();
} catch (e) {}

function seed() {
  if (!db.prepare("SELECT COUNT(*) c FROM devices").get().c) {
    const mk = (name, host, mode) => db.prepare("INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), name, host, "admin", Buffer.from("admin123").toString("base64"), 80, mode, "lab", now(), now());
    mk("GW-Jakarta-01", "192.168.1.1", "demo");
    mk("CPE-Bandung-02", "192.168.2.1", "demo");
  }
  if (!db.prepare("SELECT COUNT(*) c FROM templates").get().c) {
    const t = (name, body) => db.prepare("INSERT INTO templates VALUES(?,?,?,?,?)").run(crypto.randomUUID(), name, body, "{}", now());
    t("base-dns-ntp", "/system ntp client set enabled=yes server-dns-names=pool.ntp.org\n/ip dns set servers=8.8.8.8,1.1.1.1");
    t("base-firewall-input", "/ip firewall filter add chain=input action=accept connection-state=established,related\n/ip firewall filter add chain=input action=drop in-interface={{WAN}}");
  }
}
seed();

const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const b64d = (s) => { try { return Buffer.from(s || "", "base64").toString(); } catch { return ""; } };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

function renderTemplate(tplBody, vars) {
  return String(tplBody).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? `{{${k}}}`));
}

async function fetchROS(dev, restPath) {
  const user = dev.username, pass = b64d(dev.pass_enc);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  const t0 = Date.now();
  try {
    const r = await fetch(`http://${dev.host}:${dev.api_port}${restPath}`, { headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") }, signal: ctrl.signal });
    const latency = Date.now() - t0;
    const data = await r.text();
    let json = null; try { json = JSON.parse(data); } catch { json = { raw: data.slice(0, 4000) }; }
    return { ok: r.ok, latency, data: json };
  } catch (e) {
    return { ok: false, latency: Date.now() - t0, error: String(e.message || e) };
  } finally { clearTimeout(to); }
}

// Helper function to fetch bandwidth statistics
async function fetchBandwidth(dev) {
  if (dev.mode !== "real") {
    // simulate plausible values (bytes per second)
    const rx = 1000000 + Math.floor(Math.random() * 5000000); // 1-6 MB/s
    const tx = 800000 + Math.floor(Math.random() * 3000000);  // 0.8-3.8 MB/s
    // convert to Mbps: (bytes * 8) / 1,000,000
    return {
      rx_bytes: rx,
      tx_bytes: tx,
      rx_mbps: (rx * 8) / 1_000_000,
      tx_mbps: (tx * 8) / 1_000_000,
    };
  }
  try {
    const ifaceResp = await fetchROS(dev, "/rest/interface");
    if (!ifaceResp.ok || !Array.isArray(ifaceResp.data)) {
      throw new Error("Invalid interface response");
    }
    // Sum all interfaces for simplicity
    let rxBytes = 0, txBytes = 0;
    for (const iface of ifaceResp.data) {
      rxBytes += Number(iface["rx-byte"] ?? 0);
      txBytes += Number(iface["tx-byte"] ?? 0);
    }
    // For now, we'll store raw bytes and set Mbps to 0 (we'd need previous samples to calculate rate)
    // In a more sophisticated implementation, we'd store previous samples and calculate delta
    return {
      rx_bytes: rxBytes,
      tx_bytes: txBytes,
      rx_mbps: 0, // placeholder - would need historical data for accurate calculation
      tx_mbps: 0,
    };
  } catch (e) {
    console.log(`[bandwidth-error] ${dev.name}:`, e.message);
    return { rx_bytes: 0, tx_bytes: 0, rx_mbps: 0, tx_mbps: 0 };
  }
}

async function pollDevice(dev) {
  let reachable = 0, latency = -1, cpu = null, mem = null, up = null, note = "demo";
  let rx_bytes = null, tx_bytes = null, rx_mbps = null, tx_mbps = null;
  
  if (dev.mode === "real") {
    const r = await fetchROS(dev, "/rest/system/resource");
    reachable = r.ok ? 1 : 0; latency = r.latency; note = r.ok ? "ros-rest-ok" : ("ros-rest-fail:" + (r.error || "http"));
    if (r.ok && r.data && typeof r.data === "object") {
      cpu = Number(r.data["cpu-load"] ?? null); up = Number(r.data.uptime ?? null);
      const free = Number(r.data["free-memory"] ?? 0), total = Number(r.data["total-memory"] ?? 0);
      if (total > 0) mem = Math.round((1 - free / total) * 100);
    }
    // Get bandwidth statistics for real devices
    const bw = await fetchBandwidth(dev);
    rx_bytes = bw.rx_bytes;
    tx_bytes = bw.tx_bytes;
    rx_mbps = bw.rx_mbps;
    tx_mbps = bw.tx_mbps;
  } else {
    reachable = 1; latency = 5 + Math.floor(Math.random() * 20);
    cpu = 5 + Math.floor(Math.random() * 40); mem = 30 + Math.floor(Math.random() * 40); up = 86400 + Math.floor(Math.random() * 90000);
    note = "demo-simulated";
    // Simulate bandwidth for demo mode
    const bw = await fetchBandwidth(dev);
    rx_bytes = bw.rx_bytes;
    tx_bytes = bw.tx_bytes;
    rx_mbps = bw.rx_mbps;
    tx_mbps = bw.tx_mbps;
  }
  db.prepare("INSERT INTO monitor(device_id,ts,reachable,latency_ms,cpu,mem_pct,uptime_s,note,rx_bytes,tx_bytes,rx_mbps,tx_mbps) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(dev.id, now(), reachable, latency, cpu, mem, up, note, rx_bytes, tx_bytes, rx_mbps, tx_mbps);
  if (!reachable) db.prepare("INSERT INTO alerts(device_id,ts,level,msg) VALUES(?,?,?,?)").run(dev.id, now(), "critical", `Device ${dev.name} unreachable (${note})`);
  if (cpu !== null && cpu > 90) db.prepare("INSERT INTO alerts(device_id,ts,level,msg) VALUES(?,?,?,?)").run(dev.id, now(), "warning", `CPU ${cpu}% on ${dev.name}`);
  // auto daily backup
  const last = db.prepare("SELECT ts FROM backups WHERE device_id=? ORDER BY ts DESC LIMIT 1").get(dev.id);
  if (!last || Date.now() - new Date(last.ts).getTime() > 24 * 3600 * 1000) await makeBackup(dev, "auto-daily");
  // retention 30 days
  db.prepare("DELETE FROM backups WHERE device_id=? AND ts < ?").run(dev.id, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
}

async function makeBackup(dev, kind = "manual") {
  let content = "";
  if (dev.mode === "real") {
    const r = await fetchROS(dev, "/rest/export");
    content = r.ok ? JSON.stringify(r.data).slice(0, 20000) : `# export-fallback ${now()}\n# host=${dev.host} note=${r.error || "http-fail"}\n/system identity print\n/ip address print`;
  } else {
    content = `# demo-export ${dev.name} ${now()}\n/system identity set name=${dev.name}\n/ip address print\n/ip route print\n/system resource print`;
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO backups VALUES(?,?,?,?,?,?,?)").run(id, dev.id, now(), kind, content, content.length, sha(content));
  return { id, size: content.length, hash: sha(content) };
}

async function pollAll() {
  const devs = db.prepare("SELECT * FROM devices").all();
  for (const d of devs) { try { await pollDevice(d); } catch (e) { console.log("[poll-fail]", d.name, e.message); } }
}
setInterval(pollAll, 60000); pollAll();

function serveStatic(req, res) {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const f = path.join(DIR, "public", decodeURIComponent(p).replace(/^\//, ""));
  if (!f.startsWith(path.join(DIR, "public"))) return send(res, 403, { error: "forbidden" });
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return null;
  const ext = path.extname(f);
  const ct = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct }); fs.createReadStream(f).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && !u.pathname.startsWith("/api/")) {
    if (serveStatic(req, res)) return;
    if (u.pathname === "/" || !u.pathname.includes(".")) {
      const idx = path.join(DIR, "public", "index.html");
      res.writeHead(200, { "Content-Type": "text/html" }); fs.createReadStream(idx).pipe(res); return;
    }
    return send(res, 404, { error: "not found" });
  }
  try {
    // devices
    if (u.pathname === "/api/devices" && req.method === "GET") return send(res, 200, db.prepare("SELECT id,name,host,username,api_port,mode,tags,created_at FROM devices ORDER BY name").all());
    if (u.pathname === "/api/devices" && req.method === "POST") {
      const b = await body(req);
      if (!b.name || !b.host) return send(res, 400, { error: "name+host required" });
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, b.name, b.host, b.username || "admin", Buffer.from(b.password || "").toString("base64"), b.api_port || 80, b.mode || "demo", b.tags || "", now(), now());
      return send(res, 201, { id });
    }
    let m = u.pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (m) {
      const id = m[1], dev = db.prepare("SELECT * FROM devices WHERE id=?").get(id);
      if (!dev) return send(res, 404, { error: "device not found" });
      if (req.method === "GET") { const { pass_enc, ...safe } = dev; return send(res, 200, safe); }
      if (req.method === "PUT") { const b = await body(req); db.prepare("UPDATE devices SET name=?,host=?,username=?,api_port=?,mode=?,tags=?,updated_at=? WHERE id=?").run(b.name ?? dev.name, b.host ?? dev.host, b.username ?? dev.username, b.api_port ?? dev.api_port, b.mode ?? dev.mode, b.tags ?? dev.tags, now(), id); if (b.password) db.prepare("UPDATE devices SET pass_enc=? WHERE id=?").run(Buffer.from(b.password).toString("base64"), id); return send(res, 200, { ok: true }); }
      if (req.method === "DELETE") { db.prepare("DELETE FROM devices WHERE id=?").run(id); return send(res, 200, { ok: true }); }
    }
    m = u.pathname.match(/^\/api\/devices\/([^/]+)\/test$/);
    if (m && req.method === "POST") {
      const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(m[1]);
      if (!dev) return send(res, 404, { error: "not found" });
      if (dev.mode !== "real") return send(res, 200, { ok: true, mode: "demo", msg: "demo mode: no real connection" });
      const r = await fetchROS(dev, "/rest/system/identity");
      return send(res, 200, { ok: r.ok, latency: r.latency, data: r.data || r.error });
    }
    // backups
    m = u.pathname.match(/^\/api\/devices\/([^/]+)\/backups$/);
    if (m && req.method === "GET") return send(res, 200, db.prepare("SELECT id,device_id,ts,kind,size,hash FROM backups WHERE device_id=? ORDER BY ts DESC LIMIT 100").all(m[1]));
    m = u.pathname.match(/^\/api\/devices\/([^/]+)\/backup$/);
    if (m && req.method === "POST") {
      const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(m[1]);
      if (!dev) return send(res, 404, { error: "not found" });
      return send(res, 201, await makeBackup(dev, "manual"));
    }
    m = u.pathname.match(/^\/api\/backups\/([^/]+)$/);
    if (m && req.method === "GET") {
      const r = db.prepare("SELECT * FROM backups WHERE id=?").get(m[1]);
      if (!r) return send(res, 404, { error: "not found" });
      if (u.searchParams.get("full") === "1") return send(res, 200, r);
      return send(res, 200, { ...r, content: r.content.slice(0, 8000), truncated: r.content.length > 8000 });
    }
    m = u.pathname.match(/^\/api\/backups\/([^/]+)\/diff$/);
    if (m && req.method === "GET") {
      const a = db.prepare("SELECT * FROM backups WHERE id=?").get(m[1]);
      const bId = u.searchParams.get("with");
      const b = bId ? db.prepare("SELECT * FROM backups WHERE id=?").get(bId) : db.prepare("SELECT * FROM backups WHERE device_id=? AND id!=? ORDER BY ts DESC LIMIT 1").get(a?.device_id, m[1]);
      if (!a || !b) return send(res, 404, { error: "need two revisions" });
      const la = new Set(a.content.split("\n")), lb = new Set(b.content.split("\n"));
      const added = [...la].filter((x) => !lb.has(x)).slice(0, 100), removed = [...lb].filter((x) => !la.has(x)).slice(0, 100);
      return send(res, 200, { a: { id: a.id, ts: a.ts }, b: { id: b.id, ts: b.ts }, added, removed });
    }
    m = u.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (m && req.method === "POST") {
      const bk = db.prepare("SELECT * FROM backups WHERE id=?").get(m[1]);
      if (!bk) return send(res, 404, { error: "not found" });
      const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(bk.device_id);
      db.prepare("INSERT INTO alerts(device_id,ts,level,msg) VALUES(?,?,?,?)").run(dev.id, now(), "info", `Restore ${bk.id.slice(0, 8)} to ${dev.name} (simulated${dev.mode === "real" ? "+manual paste ke terminal" : ""})`);
      return send(res, 200, { ok: true, note: dev.mode === "real" ? "Copy konten backup ke terminal Winbox/SSH (atomic rollback manual)." : "Demo: restore tercatat di alerts.", content: bk.content.slice(0, 8000) });
    }
    // monitor
    m = u.pathname.match(/^\/api\/devices\/([^/]+)\/monitor$/);
    if (m && req.method === "GET") return send(res, 200, db.prepare("SELECT * FROM monitor WHERE device_id=? ORDER BY ts DESC LIMIT ?").all(m[1], Number(u.searchParams.get("limit") || 50)));
    if (u.pathname === "/api/monitor/summary" && req.method === "GET") {
      const devs = db.prepare("SELECT * FROM devices").all();
      const out = devs.map((d) => {
        const last = db.prepare("SELECT * FROM monitor WHERE device_id=? ORDER BY ts DESC LIMIT 1").get(d.id);
        return { 
          device: { id: d.id, name: d.name, host: d.host, mode: d.mode }, 
          last: last || null, 
          backups: db.prepare("SELECT COUNT(*) c FROM backups WHERE device_id=?").get(d.id).c 
        };
      });
      return send(res, 200, out);
    }
    // templates
    if (u.pathname === "/api/templates" && req.method === "GET") return send(res, 200, db.prepare("SELECT * FROM templates ORDER BY name").all());
    if (u.pathname === "/api/templates" && req.method === "POST") {
      const b = await body(req); if (!b.name || !b.body) return send(res, 400, { error: "name+body required" });
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO templates VALUES(?,?,?,?,?)").run(id, b.name, b.body, JSON.stringify(b.vars || {}), now());
      return send(res, 201, { id });
    }
    m = u.pathname.match(/^\/api\/templates\/([^/]+)\/apply\/([^/]+)$/);
    if (m && req.method === "POST") {
      const tpl = db.prepare("SELECT * FROM templates WHERE id=?").get(m[1]);
      const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(m[2]);
      if (!tpl || !dev) return send(res, 404, { error: "template/device not found" });
      const b = await body(req);
      const rendered = renderTemplate(tpl.body, b.vars || {});
      db.prepare("INSERT INTO applies(template_id,device_id,ts,status,log) VALUES(?,?,?,?,?)").run(tpl.id, dev.id, now(), dev.mode === "real" ? "staged-real" : "applied-demo", rendered.slice(0, 5000));
      return send(res, 200, { ok: true, rendered: rendered.slice(0, 8000), note: dev.mode === "real" ? "Staged. Paste ke terminal / gunakan API untuk atomic apply + rollback." : "Demo apply tercatat." });
    }
    // troubleshoot
    m = u.pathname.match(/^\/api\/troubleshoot\/([^/]+)$/);
    if (m && req.method === "GET") {
      const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(m[1]);
      if (!dev) return send(res, 404, { error: "not found" });
      if (dev.mode === "real") {
        const [res1, id1] = await Promise.all([fetchROS(dev, "/rest/system/resource"), fetchROS(dev, "/rest/log?limit=20")]);
        return send(res, 200, { resource: res1, log: id1 });
      }
      return send(res, 200, { resource: { ok: true, data: { "cpu-load": 12, uptime: 90000, version: "7.x-demo" } }, log: { ok: true, data: [{ time: now(), message: "demo log line" }] } });
    }
    // alerts
    if (u.pathname === "/api/alerts" && req.method === "GET") return send(res, 200, db.prepare("SELECT a.*, d.name dev FROM alerts a LEFT JOIN devices d ON d.id=a.device_id ORDER BY id DESC LIMIT 100").all());
    m = u.pathname.match(/^\/api\/alerts\/(\d+)\/ack$/);
    if (m && req.method === "POST") { db.prepare("UPDATE alerts SET ack=1 WHERE id=?").run(m[1]); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: "unknown route" });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
});

server.listen(PORT, () => console.log(`[optiwize-lokal] http://localhost:${PORT}`));
