/**
 * Live auth check against a running backend.
 *
 * Usage: npm run verify:auth
 *   API_URL         provider/admin API (default http://localhost:3000)
 *   DEVICE_API_URL  where simulated devices open their socket (default API_URL;
 *                   point it at a second instance to cross the pub/sub hop)
 *
 * Needs the seeded admin (admin / password123). Shows that the normal
 * register → send → deliver → ack flow works, and that device hijack, foreign
 * acks, unauthenticated admin/provider calls, and cross-app sends are refused.
 * Exits non-zero if any check fails.
 *
 * @module scripts/verifyAuth
 */

import crypto from "crypto";
import WebSocket from "ws";
import { signProviderToken } from "../shared/providerToken.js";

const API_URL = process.env.API_URL || "http://localhost:3000";
const DEVICE_API_URL = process.env.DEVICE_API_URL || API_URL;
const WS_URL = `${DEVICE_API_URL.replace(/^http/, "ws")}/ws`;

let failures = 0;

function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomToken = () => crypto.randomBytes(32).toString("hex");

async function api(
  method: string,
  path: string,
  options: { auth?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
  if (options.auth) headers.Authorization = `Bearer ${options.auth}`;
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

type Message = Record<string, unknown>;

/** A simulated device socket that buffers messages for predicate waits. */
class Device {
  private messages: Message[] = [];
  private waiters: Array<{ match: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Message;
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
    this.closed = new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
    );
  }

  static open(): Promise<Device> {
    const ws = new WebSocket(WS_URL);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(new Device(ws)));
      ws.once("error", reject);
    });
  }

  send(message: Message): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolves with the first matching message, or null after timeoutMs. */
  next(match: (m: Message) => boolean, timeoutMs = 3000): Promise<Message | null> {
    const buffered = this.messages.find(match);
    if (buffered) {
      this.messages.splice(this.messages.indexOf(buffered), 1);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve) => {
      const waiter = { match, resolve: (m: Message | null) => resolve(m) };
      this.waiters.push(waiter as { match: (m: Message) => boolean; resolve: (m: Message) => void });
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter as never);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  async connect(deviceToken: string): Promise<Message | null> {
    this.send({ type: "connect", device_token: deviceToken });
    return this.next((m) => m.type === "connected" || m.type === "error");
  }

  close(): void {
    this.ws.close();
  }
}

const byType = (type: string) => (m: Message) => m.type === type;
const notificationWithId = (id: unknown) => (m: Message) => m.type === "notification" && m.id === id;
const PAYLOAD = { aps: { alert: { title: "Auth check", body: "hello" } } };

async function main(): Promise<void> {
  console.log(`API ${API_URL}, devices on ${WS_URL}\n`);

  // ---- Setup: admin session, two provider keys, two devices -------------
  const login = await api("POST", "/api/v1/admin/login", {
    body: { username: "admin", password: "password123" },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login)}`);
  const session = login.body.token as string;

  const suffix = crypto.randomBytes(3).toString("hex");
  const appBundle = `com.authcheck.a${suffix}`;
  const otherBundle = `com.authcheck.b${suffix}`;

  const keyA = await api("POST", "/api/v1/admin/provider-keys", {
    auth: session,
    body: { team_id: "TEAMAUTH01", app_bundle_ids: [appBundle] },
  });
  const keyB = await api("POST", "/api/v1/admin/provider-keys", {
    auth: session,
    body: { team_id: "TEAMAUTH02", app_bundle_ids: [otherBundle] },
  });
  check("admin issues provider keys (private key returned once)", keyA.status === 201 && typeof keyA.body.private_key === "string", keyA);
  const jwtFor = (key: Record<string, unknown>, issuedAt?: number) =>
    signProviderToken({
      keyId: key.key_id as string,
      teamId: key.team_id as string,
      privateKey: key.private_key as string,
      issuedAt,
    });
  const jwtA = jwtFor(keyA.body);
  const jwtB = jwtFor(keyB.body);

  const listedKeys = await api("GET", "/api/v1/admin/provider-keys", { auth: session });
  check(
    "provider key listing omits key material",
    listedKeys.status === 200 && !JSON.stringify(listedKeys.body).includes("PRIVATE KEY") && !JSON.stringify(listedKeys.body).includes("PUBLIC KEY"),
    listedKeys.status
  );

  const victimToken = randomToken();
  const attackerToken = randomToken();
  const victim = await api("POST", "/api/v1/devices/register", {
    body: { token: victimToken, app_bundle_id: appBundle, device_info: { platform: "iOS" } },
  });
  const attacker = await api("POST", "/api/v1/devices/register", {
    body: { token: attackerToken, app_bundle_id: appBundle, device_info: { platform: "iOS" } },
  });
  const victimId = victim.body.device_id as string;
  check("devices register with raw tokens", victim.status === 201 && attacker.status === 201, { victim, attacker });

  // ---- Normal flow: register → send (offline) → connect → deliver → ack --
  console.log("\nNormal flow");
  const queued = await api("POST", `/api/v1/notifications/device/${victimToken}`, {
    auth: jwtA,
    body: { payload: PAYLOAD, priority: 10 },
  });
  check("provider JWT send to offline device is queued", queued.status === 200 && queued.body.status === "queued", queued);

  const phone = await Device.open();
  const connected = await phone.connect(victimToken);
  check(
    "device authenticates with its raw token and gets its pending queue",
    connected?.type === "connected" && connected.device_id === victimId && connected.pending_delivered === 1,
    connected
  );
  const pending = await phone.next(notificationWithId(queued.body.notification_id));
  check("queued notification is delivered on connect", pending !== null, pending);
  phone.send({ type: "ack", notification_id: queued.body.notification_id });
  await sleep(300);
  const afterAck = await api("GET", `/api/v1/notifications/${queued.body.notification_id}`, { auth: jwtA });
  check("ack marks the device's own notification delivered", afterAck.body.status === "delivered", afterAck.body.status);

  const online = await api("POST", `/3/device/${victimToken}`, {
    body: PAYLOAD,
    headers: { authorization: `bearer ${jwtA}`, "apns-priority": "10" },
  });
  const onlineMessage = online.status === 200 ? await phone.next(byType("notification")) : null;
  check("/3/device send with provider JWT reaches the live socket", onlineMessage !== null, { online, onlineMessage });
  if (onlineMessage) phone.send({ type: "ack", notification_id: onlineMessage.id });

  const consoleSend = await api("POST", `/api/v1/notifications/device-id/${victimId}`, {
    auth: session,
    body: { payload: PAYLOAD, priority: 10 },
  });
  const consoleDelivered = await phone.next(byType("notification"));
  check("console admin session can still send test pushes", consoleSend.status === 200 && consoleDelivered !== null, consoleSend);

  // A second socket for the same device replaces the first without losing the route
  const phone2 = await Device.open();
  const reconnect = await phone2.connect(victimToken);
  const replaced = await Promise.race([phone.closed, sleep(2000).then(() => null)]);
  await sleep(200);
  const afterReplace = await api("POST", `/api/v1/notifications/device/${victimToken}`, {
    auth: jwtA,
    body: { payload: PAYLOAD },
  });
  const toNewSocket = await phone2.next(byType("notification"));
  check(
    "reconnect replaces the old socket (4409) and keeps routing to the new one",
    reconnect?.type === "connected" && replaced?.code === 4409 && afterReplace.body.status === "delivered" && toNewSocket !== null,
    { replaced, afterReplace: afterReplace.body, toNewSocket }
  );
  phone2.close();
  await phone2.closed;
  await sleep(300);

  // ---- Device-channel attacks -------------------------------------------
  console.log("\nDevice channel");
  const victimQueued = await api("POST", `/api/v1/notifications/device/${victimToken}`, {
    auth: jwtA,
    body: { payload: { aps: { alert: "private to victim" } } },
  });
  check("victim is offline again; new push is queued", victimQueued.body.status === "queued", victimQueued.body);

  const hijacker = await Device.open();
  hijacker.send({ type: "connect", device_id: victimId });
  const hijack = await hijacker.next(byType("error"));
  const hijackClose = await Promise.race([hijacker.closed, sleep(2000).then(() => null)]);
  const leaked = await hijacker.next(byType("notification"), 500);
  check(
    "connect with the victim's device_id (no token) is refused and closed",
    hijack?.error === "InvalidToken" && hijackClose?.code === 4401 && leaked === null,
    { hijack, hijackClose, leaked }
  );

  const routeCheck = await api("POST", `/api/v1/notifications/device-id/${victimId}`, {
    auth: jwtA,
    body: { payload: PAYLOAD },
  });
  check("hijack attempt did not repoint the victim's route (send still queues)", routeCheck.body.status === "queued", routeCheck.body);

  const guesser = await Device.open();
  const guess = await guesser.connect(randomToken());
  check("connect with an unregistered token is refused", guess?.type === "error" && guess.error === "Unregistered", guess);

  const impostor = await Device.open();
  const impostorConnected = await impostor.connect(attackerToken);
  impostor.send({ type: "ack", notification_id: victimQueued.body.notification_id });
  const foreignAck = await impostor.next(byType("error"));
  await sleep(200);
  const stillQueued = await api("GET", `/api/v1/notifications/${victimQueued.body.notification_id}`, { auth: jwtA });
  check(
    "a different authenticated device cannot ack the victim's notification",
    impostorConnected?.type === "connected" && foreignAck?.error === "UnknownNotification" && stillQueued.body.status === "queued",
    { foreignAck, status: stillQueued.body.status }
  );
  impostor.close();

  const anonymous = await Device.open();
  anonymous.send({ type: "ack", notification_id: victimQueued.body.notification_id });
  const anonymousAck = await anonymous.next(byType("error"));
  check("ack before connect is refused", anonymousAck?.error === "Unauthenticated", anonymousAck);
  anonymous.close();

  const invalidate = await api("DELETE", `/api/v1/devices/token/${attackerToken}`, { body: { reason: "Uninstalled" } });
  const uninstalled = await Device.open();
  const uninstalledConnect = await uninstalled.connect(attackerToken);
  check(
    "an invalidated token can no longer open a device socket",
    invalidate.status === 204 && uninstalledConnect?.error === "Unregistered",
    { invalidate: invalidate.status, uninstalledConnect }
  );

  const victimBack = await Device.open();
  const victimReconnect = await victimBack.connect(victimToken);
  const victimMail = await victimBack.next(notificationWithId(victimQueued.body.notification_id));
  check(
    "victim's queue survived every attack and is delivered to the victim",
    victimReconnect?.type === "connected" && (victimReconnect.pending_delivered as number) >= 1 && victimMail !== null,
    { victimReconnect, victimMail }
  );
  victimBack.close();

  // ---- Admin API ----------------------------------------------------------
  console.log("\nAdmin API");
  const newAdmin = `intruder${suffix}`;
  const createAnon = await api("POST", "/api/v1/admin/users", {
    body: { username: newAdmin, password: "pwned12345" },
  });
  const createWithJwt = await api("POST", "/api/v1/admin/users", {
    auth: jwtA,
    body: { username: newAdmin, password: "pwned12345" },
  });
  const intruderLogin = await api("POST", "/api/v1/admin/login", {
    body: { username: newAdmin, password: "pwned12345" },
  });
  check(
    "admin account creation without a session is refused (and nothing is created)",
    createAnon.status === 401 && createWithJwt.status === 401 && intruderLogin.status === 401,
    { createAnon: createAnon.status, createWithJwt: createWithJwt.status, intruderLogin: intruderLogin.status }
  );
  const devicesAnon = await api("GET", "/api/v1/admin/devices");
  const broadcastAnon = await api("POST", "/api/v1/admin/broadcast", { body: { payload: PAYLOAD } });
  const keyAnon = await api("POST", "/api/v1/admin/provider-keys", {
    body: { team_id: "TEAMAUTH03", app_bundle_ids: [appBundle] },
  });
  check(
    "device listing, broadcast and key issuance need a session",
    devicesAnon.status === 401 && broadcastAnon.status === 401 && keyAnon.status === 401,
    { devices: devicesAnon.status, broadcast: broadcastAnon.status, keys: keyAnon.status }
  );
  const stats = await api("GET", "/api/v1/admin/stats", { auth: session });
  const me = await api("GET", "/api/v1/admin/me", { auth: session });
  check("console endpoints work with the session", stats.status === 200 && me.body.username === "admin", { stats: stats.status, me: me.body });

  // ---- Provider API ---------------------------------------------------------
  console.log("\nProvider API");
  const sendAnon = await api("POST", `/api/v1/notifications/device/${victimToken}`, { body: { payload: PAYLOAD } });
  const sendByIdAnon = await api("POST", `/api/v1/notifications/device-id/${victimId}`, { body: { payload: PAYLOAD } });
  const topicAnon = await api("POST", "/api/v1/notifications/topic/news.breaking", { body: { payload: PAYLOAD } });
  const apnsAnon = await api("POST", `/3/device/${victimToken}`, { body: PAYLOAD });
  const listAnon = await api("GET", "/api/v1/notifications");
  check(
    "unauthenticated provider sends and history reads are refused",
    sendAnon.status === 401 && sendByIdAnon.status === 401 && topicAnon.status === 401 && listAnon.status === 401 &&
      apnsAnon.status === 403 && apnsAnon.body.reason === "MissingProviderToken",
    { sendAnon: sendAnon.status, sendByIdAnon: sendByIdAnon.status, topicAnon: topicAnon.status, listAnon: listAnon.status, apnsAnon }
  );

  const forgedKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const forged = signProviderToken({ keyId: keyA.body.key_id as string, teamId: "TEAMAUTH01", privateKey: forgedKey });
  const forgedSend = await api("POST", `/3/device/${victimToken}`, { body: PAYLOAD, headers: { authorization: `bearer ${forged}` } });
  check("JWT signed with the wrong private key is refused", forgedSend.status === 403 && forgedSend.body.reason === "InvalidProviderToken", forgedSend);

  const expired = jwtFor(keyA.body, Math.floor(Date.now() / 1000) - 2 * 3600);
  const expiredSend = await api("POST", `/3/device/${victimToken}`, { body: PAYLOAD, headers: { authorization: `bearer ${expired}` } });
  check("JWT older than an hour is refused", expiredSend.status === 403 && expiredSend.body.reason === "ExpiredProviderToken", expiredSend);

  const crossSend = await api("POST", `/api/v1/notifications/device/${victimToken}`, { auth: jwtB, body: { payload: PAYLOAD } });
  const crossSendById = await api("POST", `/api/v1/notifications/device-id/${victimId}`, { auth: jwtB, body: { payload: PAYLOAD } });
  const crossApns = await api("POST", `/3/device/${victimToken}`, { body: PAYLOAD, headers: { authorization: `bearer ${jwtB}` } });
  check(
    "another app's provider key cannot send to this app's device",
    crossSend.status === 403 && crossSendById.status === 403 && crossApns.status === 400 && crossApns.body.reason === "DeviceTokenNotForTopic",
    { crossSend: crossSend.status, crossSendById: crossSendById.status, crossApns }
  );

  const crossRead = await api("GET", `/api/v1/notifications/${victimQueued.body.notification_id}`, { auth: jwtB });
  const crossList = await api("GET", "/api/v1/notifications?limit=500", { auth: jwtB });
  const ownList = await api("GET", "/api/v1/notifications?limit=500", { auth: jwtA });
  const crossFeedback = await api("GET", `/api/v1/feedback/${appBundle}`, { auth: jwtB });
  const crossDevice = await api("GET", `/api/v1/devices/${victimId}`, { auth: jwtB });
  const ownIds = ((ownList.body.notifications as Message[]) ?? []).map((n) => n.id);
  check(
    "another app's provider key cannot read this app's history, feedback, or devices",
    crossRead.status === 404 && crossList.body.total === 0 && crossFeedback.status === 403 && crossDevice.status === 404 &&
      ownIds.includes(victimQueued.body.notification_id),
    { crossRead: crossRead.status, crossTotal: crossList.body.total, crossFeedback: crossFeedback.status, crossDevice: crossDevice.status }
  );

  const revoke = await api("DELETE", `/api/v1/admin/provider-keys/${keyB.body.key_id}`, { auth: session });
  const revokedSend = await api("POST", `/api/v1/notifications/topic/news.breaking`, { auth: jwtB, body: { payload: PAYLOAD } });
  check("revoked provider key stops working immediately", revoke.status === 204 && revokedSend.status === 401, { revoke: revoke.status, revokedSend: revokedSend.status });

  console.log(failures === 0 ? "\nAll auth checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
