import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
const DOORBELL_BODY_CAP = 20 * 1024 * 1024;
const DOORBELL_REQUEST_TIMEOUT_MS = 5e3;
const DOORBELL_HEADERS_TIMEOUT_MS = 2e3;
const DOORBELL_MAX_HEADERS = 32;
const DRAIN_TIMEOUT_MS = 1e4;
const RATE_WINDOW_MS = 1e3;
const RATE_MAX_PER_WINDOW = 30;
const SECRET_BYTES = 32;
function constantTimeEquals(a, b) {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
function isLoopbackRemote(address) {
  const a = (address ?? "").replace(/^::ffff:/i, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
function createDoorbell(deps) {
  let port = 0;
  let secret = null;
  let accepted = 0;
  let rejected = 0;
  let bytesDrained = 0;
  const recent = [];
  const sockets = /* @__PURE__ */ new Set();
  const withinRateLimit = () => {
    const now = Date.now();
    while (recent.length > 0 && now - recent[0] > RATE_WINDOW_MS) recent.shift();
    if (recent.length >= RATE_MAX_PER_WINDOW) return false;
    recent.push(now);
    return true;
  };
  const reject = (req, res) => {
    rejected += 1;
    res.writeHead(404, { "Content-Length": "0", Connection: "close" });
    res.end();
    req.socket.destroy();
  };
  const accept = (req, res) => {
    res.writeHead(200, { "Content-Length": "0" });
    res.end();
    accepted += 1;
    deps.onRing();
    let drained = 0;
    const timer = setTimeout(() => req.socket.destroy(), DRAIN_TIMEOUT_MS);
    timer.unref();
    const finish = () => clearTimeout(timer);
    req.on("data", (chunk) => {
      drained += chunk.length;
      bytesDrained += chunk.length;
      if (drained > DOORBELL_BODY_CAP) {
        finish();
        req.socket.destroy();
      }
    });
    req.once("end", finish);
    req.once("error", finish);
    req.once("close", finish);
    req.resume();
  };
  const handle = (req, res) => {
    if (!withinRateLimit()) return reject(req, res);
    if (!isLoopbackRemote(req.socket.remoteAddress)) return reject(req, res);
    if (req.method !== "POST") return reject(req, res);
    if (req.headers.origin !== void 0) return reject(req, res);
    if (req.headers.host !== `127.0.0.1:${port}`) return reject(req, res);
    if (secret === null) return reject(req, res);
    if (!constantTimeEquals(req.url ?? "", `/hook/${secret}`)) return reject(req, res);
    const expected = deps.token();
    const presented = req.headers["x-bridge-token"];
    if (expected === null || expected === "" || typeof presented !== "string") return reject(req, res);
    if (!constantTimeEquals(presented, expected)) return reject(req, res);
    return accept(req, res);
  };
  const server = http.createServer(handle);
  server.requestTimeout = DOORBELL_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DOORBELL_HEADERS_TIMEOUT_MS;
  server.maxHeadersCount = DOORBELL_MAX_HEADERS;
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  server.on("clientError", (_err, s) => s.destroy());
  return {
    start: () => new Promise((resolve, rejectStart) => {
      server.once("error", rejectStart);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.removeListener("error", rejectStart);
        port = server.address().port;
        resolve({ port });
      });
    }),
    newWebhookUrl: () => {
      if (port === 0) throw new Error("doorbell: start() must resolve before newWebhookUrl()");
      secret = randomBytes(SECRET_BYTES).toString("base64url");
      return `http://127.0.0.1:${port}/hook/${secret}`;
    },
    stop: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
    stats: () => ({ accepted, rejected, bytesDrained })
  };
}
export {
  DOORBELL_BODY_CAP,
  DOORBELL_HEADERS_TIMEOUT_MS,
  DOORBELL_MAX_HEADERS,
  DOORBELL_REQUEST_TIMEOUT_MS,
  createDoorbell
};
