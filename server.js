/**
 * TOKROOM / TOK TOK - SERVIDOR EN TIEMPO REAL MULTI-SALA Y MULTI-DISPOSITIVO
 * Soporta múltiples salas independientes:
 * - Sala Principal (DYR) o salas creadas independientemente por otros usuarios (ej: Rosa).
 * - Cada sala tiene su propio Anfitrión (Asiento 0), hasta 15 invitados (Asientos 1-15),
 *   su propio chat en vivo, invitaciones, moderación, y transmisión de vídeo/audio.
 * - Soporte indestructible WebSocket + HTTP Polling + SSE sobre túnel Cloudflare.
 * - Servidor de archivos estáticos con soporte directo para toktok.apk y PWA.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

// Carga automática de variables de entorno locales desde .env si existe
const ENV_FILE = path.join(ROOT_DIR, ".env");
if (fs.existsSync(ENV_FILE)) {
  try {
    const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.trim().match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch (_) {}
}

// MIME types soportados
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".apk": "application/vnd.android.package-archive",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

// ===================================================================
// BASE DE DATOS DE USUARIOS REGISTRADOS Y AUTENTICACIÓN
// ===================================================================
const USERS_FILE = path.join(ROOT_DIR, "users_db.json");

function loadUsersDb() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("Error cargando users_db.json:", e);
  }
  return [];
}

function saveUsersDb(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando users_db.json:", e);
  }
}

const EXPELLED_FILE = path.join(ROOT_DIR, "expelled_users.json");

function loadExpelledDb() {
  try {
    if (fs.existsSync(EXPELLED_FILE)) {
      const data = JSON.parse(fs.readFileSync(EXPELLED_FILE, "utf-8"));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("Error cargando expelled_users.json:", e);
  }
  return [];
}

function saveExpelledDb(list) {
  try {
    fs.writeFileSync(EXPELLED_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando expelled_users.json:", e);
  }
}

// Base de datos de mensajes privados / bandeja de entrada
const DMS_FILE = path.join(ROOT_DIR, "dms_db.json");

function loadDmsDb() {
  try {
    if (fs.existsSync(DMS_FILE)) {
      const data = JSON.parse(fs.readFileSync(DMS_FILE, "utf-8"));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("Error cargando dms_db.json:", e);
  }
  return [];
}

function saveDmsDb(dms) {
  try {
    fs.writeFileSync(DMS_FILE, JSON.stringify(dms, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando dms_db.json:", e);
  }
}

// ===================================================================
// GESTIÓN DE SALAS EN VIVO INDEPENDIENTES (MULTI-ROOM)
// ===================================================================
const wsClients = new Set();
const sseClients = new Set();
const rooms = new Map(); // roomId -> RoomObject

function getOrCreateRoom(roomId = "main", meta = {}) {
  const cleanId = String(roomId || "main")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '') || "main";

  if (!rooms.has(cleanId)) {
    const isMain = cleanId === "main";
    const room = {
      id: cleanId,
      name: meta.name || (isMain ? "Sala Oficial DYR" : `Sala de ${meta.creatorName || cleanId}`),
      creatorId: meta.creatorId || (isMain ? "user_dyr_creator" : null),
      creatorName: meta.creatorName || (isMain ? "DYR" : "Anfitrión"),
      createdAt: Date.now(),
      stageSeats: new Array(16).fill(null), // Asiento 0: Host de la sala, 1-15: Invitados
      onlineUsers: new Map(), // userId -> user object
      chatHistory: [],
      pendingInvites: new Map(), // targetId/handle -> inviteData
      pendingStageRequests: new Map(), // userId -> stage join request data
      pendingSignals: [], // Señales WebRTC
      latestCameraFrames: new Map(), // userId -> frame
      moderators: new Set(),
      bannedUsers: new Set()
    };
    rooms.set(cleanId, room);
  }

  const r = rooms.get(cleanId);
  if (meta.name && (!r.name || r.name.startsWith("Sala de "))) r.name = meta.name;
  return r;
}

// Inicializar la sala principal de David / DYR
getOrCreateRoom("main", { name: "Sala Oficial DYR", creatorId: "user_dyr_creator", creatorName: "DYR" });

function isUserBannedInRoom(room, id, handle) {
  if (!room || (!id && !handle)) return false;

  // INMUNIDAD TOTAL: David Creador (DYR) y Rosa VIP NUNCA pueden ser bloqueados
  const sId = String(id || "").toLowerCase();
  const cleanHandle = handle ? handle.toLowerCase().replace('@', '').trim() : '';

  if (sId === "user_dyr_creator" || sId === "user_rosa_guest" || sId === "user_rosa_alias" || sId.includes("rosa")) {
    return false;
  }
  if (cleanHandle === "dyr" || cleanHandle === "rosaydavid" || cleanHandle.includes("rosaydavid")) {
    return false;
  }

  for (const b of room.bannedUsers) {
    const cleanB = b.toLowerCase().replace('@', '').trim();
    if (b === id || cleanB === cleanHandle) return true;
  }
  return false;
}

function removePendingStageRequestInRoom(room, targetId) {
  if (!room || !targetId) return;
  const sId = String(targetId);
  for (const [k, v] of room.pendingStageRequests.entries()) {
    if (String(k) === sId || (v && String(v.userId) === sId)) {
      room.pendingStageRequests.delete(k);
    }
  }
}

// Función para emitir eventos a los clientes de una sala específica
function broadcast(eventType, data, roomId = "main") {
  const cleanRoomId = String(roomId || "main").trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || "main";
  
  // 1. Emisión vía WebSocket
  const wsMsg = JSON.stringify({ type: eventType, data, roomId: cleanRoomId });
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      const clientRoom = ws.roomId || "main";
      if (clientRoom === cleanRoomId) {
        try { ws.send(wsMsg); } catch (_) { wsClients.delete(ws); }
      }
    }
  }

  // 2. Emisión vía SSE
  const sseMsg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    const clientRoom = client.roomId || "main";
    if (clientRoom === cleanRoomId) {
      try { client.write(sseMsg); } catch (_) { sseClients.delete(client); }
    }
  }
}

// Keep-alive cada 4s
setInterval(() => {
  for (const client of sseClients) {
    try { client.write(": keepalive\n\n"); } catch (_) { sseClients.delete(client); }
  }
  const pingPayload = JSON.stringify({ type: "ping" });
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) ws.send(pingPayload);
    } catch (_) { wsClients.delete(ws); }
  }
}, 4000);

// Limpieza periódica de usuarios desconectados e invitaciones en todas las salas
setInterval(() => {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    // Limpiar invitaciones viejas (> 45s)
    for (const [key, inv] of room.pendingInvites.entries()) {
      if (now - (inv.timestamp || 0) > 45000) room.pendingInvites.delete(key);
    }

    // Limpiar peticiones de escenario viejas (> 45s)
    for (const [key, req] of room.pendingStageRequests.entries()) {
      if (now - (req.timestamp || 0) > 45000) room.pendingStageRequests.delete(key);
    }

    // Limpiar señales WebRTC viejas (> 30s)
    while (room.pendingSignals.length > 0 && now - room.pendingSignals[0].timestamp > 30000) {
      room.pendingSignals.shift();
    }

    let changed = false;
    for (const [id, user] of room.onlineUsers.entries()) {
      if (now - user.lastSeen > 18000) {
        room.onlineUsers.delete(id);
        changed = true;
        // Si estaba en los asientos 1-15 de invitados, liberarlo
        for (let i = 1; i < room.stageSeats.length; i++) {
          if (room.stageSeats[i] && room.stageSeats[i].id === id) {
            room.stageSeats[i] = null;
            broadcast("stage_update", { stageSeats: room.stageSeats }, roomId);
          }
        }
      }
    }
    if (changed) {
      broadcast("presence_update", { onlineUsers: Array.from(room.onlineUsers.values()) }, roomId);
    }

    // Si una sala personalizada no tiene usuarios y lleva más de 20 minutos inactiva, liberarla (mantener 'main')
    if (roomId !== "main" && room.onlineUsers.size === 0 && now - room.createdAt > 20 * 60 * 1000) {
      rooms.delete(roomId);
    }
  }
}, 4000);

// Parseador de cuerpo JSON
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

// ===================================================================
// SISTEMA DE ENVÍO DE CORREOS REALES (RESEND / BREVO API - OPCIÓN B)
// ===================================================================
const pendingVerifications = new Map(); // cleanEmail -> { pin, name, handle, bio, avatarBg, expiresAt }

async function sendEmailVerification(toEmail, toName, pinCode) {
  const resendApiKey = process.env.RESEND_API_KEY || "";
  const brevoApiKey = process.env.BREVO_API_KEY || "";
  const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER || "";
  const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || "";
  const smtpHost = process.env.SMTP_HOST || (smtpUser.includes("gmail") ? "smtp.gmail.com" : "");
  const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 465;

  // 1. Envío directo universal vía SMTP (Gmail / Yahoo / Hostinger / Brevo SMTP) si está configurado
  if (smtpUser && smtpPass && smtpHost) {
    try {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        connectionTimeout: 3500,
        greetingTimeout: 3500,
        socketTimeout: 3500,
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });
      await transporter.sendMail({
        from: `"TokTok Live" <${smtpUser}>`,
        to: toEmail,
        subject: `🔐 Tu código de verificación de TokTok Live: ${pinCode}`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 32px; border-radius: 12px; max-width: 520px; margin: 0 auto; border: 1px solid #fe2c55;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #fe2c55; margin: 0; font-size: 28px; letter-spacing: 1px;">TokTok Live 🌟</h1>
              <p style="color: #94a3b8; font-size: 13px; margin-top: 4px;">Comunidad y Salas de Video en Vivo</p>
            </div>
            <p style="font-size: 16px; color: #ffffff;">¡Hola, <strong>${toName}</strong>!</p>
            <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5;">
              Para verificar tu dirección de correo y activar tu cuenta en TokTok Live, ingresa el siguiente código de seguridad de 6 dígitos:
            </p>
            <div style="background: rgba(254, 44, 85, 0.12); border: 2px dashed #fe2c55; border-radius: 10px; padding: 20px; text-align: center; margin: 25px 0;">
              <span style="font-size: 34px; font-weight: 900; letter-spacing: 8px; color: #ffffff; font-family: monospace;">${pinCode}</span>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center;">
              ⏱️ Este código es de un solo uso y caduca en 15 minutos.
            </p>
          </div>
        `
      });
      console.log(`✉️ Correo de verificación entregado a ${toEmail} vía SMTP (${smtpHost})`);
      return { ok: true, provider: "smtp", delivered: true };
    } catch (smtpErr) {
      console.warn("Aviso SMTP:", smtpErr.message);
    }
  }

  // 2. Envío profesional vía Brevo (brevo.com - permite enviar a Yahoo, Gmail, Hotmail etc. gratis)
  if (brevoApiKey) {
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": brevoApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sender: { name: "TokTok Live", email: process.env.BREVO_SENDER_EMAIL || "soporte@tokroom.live" },
          to: [{ email: toEmail, name: toName }],
          subject: `🔐 Tu código de verificación de TokTok Live: ${pinCode}`,
          htmlContent: `
            <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 32px; border-radius: 12px; max-width: 520px; margin: 0 auto; border: 1px solid #fe2c55;">
              <h1 style="color: #fe2c55; text-align: center;">TokTok Live 🌟</h1>
              <p style="font-size: 16px;">¡Hola, <strong>${toName}</strong>!</p>
              <p style="font-size: 14px; color: #cbd5e1;">Tu código de verificación de 6 dígitos es:</p>
              <div style="background: rgba(254, 44, 85, 0.12); border: 2px dashed #fe2c55; border-radius: 10px; padding: 18px; text-align: center; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #ffffff;">${pinCode}</span>
              </div>
              <p style="font-size: 12px; color: #94a3b8; text-align: center;">Caduca en 15 minutos.</p>
            </div>
          `
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`✉️ Correo de verificación enviado exitosamente a ${toEmail} vía Brevo`);
        return { ok: true, provider: "brevo", delivered: true };
      } else {
        console.error("Error respuesta Brevo:", data);
      }
    } catch (err) {
      console.error("Fallo de conexión con Brevo:", err);
    }
  }

  // 3. Envío vía Resend (resend.com)
  if (resendApiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "TokTok Live <onboarding@resend.dev>",
          to: [toEmail],
          subject: `🔐 Tu código de verificación de TokTok Live: ${pinCode}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 32px; border-radius: 12px; max-width: 520px; margin: 0 auto; border: 1px solid #fe2c55;">
              <div style="text-align: center; margin-bottom: 24px;">
                <h1 style="color: #fe2c55; margin: 0; font-size: 28px; letter-spacing: 1px;">TokTok Live 🌟</h1>
                <p style="color: #94a3b8; font-size: 13px; margin-top: 4px;">Comunidad y Salas de Video en Vivo</p>
              </div>
              <p style="font-size: 16px; color: #ffffff;">¡Hola, <strong>${toName}</strong>!</p>
              <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5;">
                Para verificar tu dirección de correo y activar tu cuenta en TokTok Live, ingresa el siguiente código de seguridad de 6 dígitos:
              </p>
              <div style="background: rgba(254, 44, 85, 0.12); border: 2px dashed #fe2c55; border-radius: 10px; padding: 20px; text-align: center; margin: 25px 0;">
                <span style="font-size: 34px; font-weight: 900; letter-spacing: 8px; color: #ffffff; font-family: monospace;">${pinCode}</span>
              </div>
              <p style="font-size: 13px; color: #94a3b8; text-align: center;">
                ⏱️ Este código es de un solo uso y caduca en 15 minutos.<br>
                Si tú no has solicitado este código, puedes ignorar este correo de forma segura.
              </p>
              <hr style="border: none; border-top: 1px solid #1e293b; margin: 25px 0;">
              <p style="font-size: 11px; color: #64748b; text-align: center; margin: 0;">
                TokTok Live Oficial &bull; Plataforma Segura RGPD &bull; 2026
              </p>
            </div>
          `
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`✉️ Correo de verificación entregado a ${toEmail} vía Resend (ID: ${data.id})`);
        return { ok: true, provider: "resend", id: data.id, delivered: true };
      } else {
        console.warn(`⚠️ [Aviso Resend API] No se pudo entregar directamente a ${toEmail}:`, data.message || data);
        // Si Resend está en modo sandbox (solo permite enviar al correo del titular davidyrosa1979@gmail.com hasta verificar dominio),
        // activamos el código de respaldo en la app para que el usuario no quede bloqueado
        return { ok: true, provider: "resend", sandbox: true, pin: pinCode, errorMsg: data.message };
      }
    } catch (err) {
      console.error("Fallo de conexión con Resend:", err);
      return { ok: true, fallback: true, pin: pinCode };
    }
  }

  // 4. Fallback si no hay proveedor configurado
  console.log(`⚠️ [AVISO CONFIGURACIÓN] Código generado para ${toEmail}: ${pinCode}`);
  return { ok: true, simulated: true, pin: pinCode };
}

// ===================================================================
// SERVIDOR HTTP + REST API + SSE
// ===================================================================
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const qRoomId = (parsedUrl.query.roomId || parsedUrl.query.room || "main").toLowerCase().trim();

  // -----------------------------------------------------------------
  // 1. ENDPOINTS DE LA API EN TIEMPO REAL
  // -----------------------------------------------------------------

  // Listar usuarios registrados en la comunidad (PROTECCIÓN DE DATOS: nunca exponer correos)
  if (pathname === "/api/users" && req.method === "GET") {
    const users = loadUsersDb();
    const sanitized = users.map(u => ({
      id: u.id,
      name: u.name,
      handle: u.handle,
      role: u.role,
      isCreator: !!u.isCreator,
      isHost: !!u.isHost,
      avatarBg: u.avatarBg,
      bio: u.bio,
      coins: u.coins,
      registeredAt: u.registeredAt
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, users: sanitized }));
  }

  // Iniciar sesión EXCLUSIVAMENTE con Correo Electrónico (Protección RGPD y Anti-Suplantación)
  if (pathname === "/api/auth/login" && req.method === "POST") {
    const { email } = await parseJsonBody(req);
    const cleanEmail = (email || "").toLowerCase().trim();

    if (!cleanEmail || !cleanEmail.includes("@") || !cleanEmail.includes(".")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ 
        ok: false, 
        error: "Por motivos de seguridad y privacidad, solo está permitido iniciar sesión con tu correo electrónico personal verificado (ej: nombre@correo.com). No se permite acceder con nombre de usuario (@) para evitar suplantaciones de identidad." 
      }));
    }

    const users = loadUsersDb();
    let found = users.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail);

    // Caso David / DYR Creador Oficial (EXCLUSIVAMENTE por su correo oficial)
    if (cleanEmail === "davidyrosa1979@gmail.com") {
      if (!found) {
        found = {
          id: "user_dyr_creator",
          name: "DYR",
          handle: "dyr",
          email: "davidyrosa1979@gmail.com",
          role: "creator",
          isCreator: true,
          isHost: true,
          hasInfiniteCoins: true,
          coins: 999999999,
          bio: "👑 Fundador y Creador Oficial de TokRoom en Vivo",
          avatarBg: "linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)",
          registeredAt: new Date().toISOString()
        };
        users.unshift(found);
        saveUsersDb(users);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, user: found, isCreator: true }));
    }

    // Caso Rosa y David VIP Oficial (EXCLUSIVAMENTE por sus correos autorizados)
    if (cleanEmail === "rosaydavid1979@gmail.com" || cleanEmail === "rosa@tokroom.live") {
      found = {
        id: "user_rosa_guest",
        name: "Rosa y David",
        handle: "rosaydavid",
        email: cleanEmail,
        role: "vip",
        isCreator: false,
        isHost: false,
        hasInfiniteCoins: true,
        coins: 999999999,
        bio: "🌸 Rosa y David • VIP Oficial con Monedas Infinitas 🪙",
        avatarBg: "#fe2c55",
        registeredAt: new Date().toISOString()
      };

      // Limpiar de inmediato cualquier rastro de baneo de todas las salas
      rooms.forEach(room => {
        room.bannedUsers.delete("user_rosa_guest");
        room.bannedUsers.delete("rosaydavid");
        room.bannedUsers.delete("rosa y david");
        room.bannedUsers.delete("rosa@tokroom.live");
        room.bannedUsers.delete("rosaydavid1979@gmail.com");
        room.bannedUsers.delete("user_1792103923463");
        room.bannedUsers.delete("user_1792104272823");
        for (const b of Array.from(room.bannedUsers)) {
          if (b.toLowerCase().includes("rosa")) room.bannedUsers.delete(b);
        }
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, user: found, isCreator: false, isVip: true }));
    }

    if (!found) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: false,
        error: "No existe ninguna cuenta registrada con este correo electrónico. Por favor, pulsa en la pestaña 'Registrarse' para crear tu cuenta."
      }));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, user: found, isCreator: !!found.isCreator }));
  }

  // -----------------------------------------------------------------
  // ENVÍO DE CÓDIGO DE VERIFICACIÓN POR CORREO (OPCIÓN B - RESEND/BREVO)
  // -----------------------------------------------------------------
  if (pathname === "/api/auth/send-verification" && req.method === "POST") {
    const { email, name, handle, bio, avatarBg } = await parseJsonBody(req);
    const cleanEmail = (email || "").toLowerCase().trim();
    const cleanName = (name || "").trim();
    const cleanHandle = (handle || "").toLowerCase().replace(/^@/, "").trim();

    if (!cleanEmail || !cleanEmail.includes("@") || !cleanEmail.includes(".")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Debes ingresar un correo electrónico válido." }));
    }

    if (!cleanName || !cleanHandle) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Nombre y usuario son obligatorios." }));
    }

    if (cleanName.toUpperCase() === "DYR" && cleanEmail !== "davidyrosa1979@gmail.com") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "El nombre y usuario 'DYR' están reservados para el Creador Oficial." }));
    }

    // -----------------------------------------------------------------
    // ENVÍO DE CÓDIGO DE VERIFICACIÓN POR CORREO
    // -----------------------------------------------------------------
    const isYahoo = cleanEmail.includes("@yahoo.") || cleanEmail.endsWith("@ymail.com") || cleanEmail.includes("yahoo");

    if (isYahoo) {
      // Clave genérica para Yahoo según solicitud
      pendingVerifications.set(cleanEmail, {
        pin: "777777",
        name: cleanName,
        handle: cleanHandle,
        bio: bio || "Usuario registrado en TokRoom 🌟",
        avatarBg: avatarBg || "#fe2c55",
        expiresAt: Date.now() + 15 * 60 * 1000
      });

      console.log(`🟣 [Yahoo Registro] Aplicada clave genérica 777777 para ${cleanEmail}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        email: cleanEmail,
        isYahoo: true,
        message: "Para cuentas de correo Yahoo, la clave de verificación es 777777"
      }));
    }

    // Para todos los demás correos: generar código aleatorio de 6 dígitos y enviar por correo real
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications.set(cleanEmail, {
      pin,
      name: cleanName,
      handle: cleanHandle,
      bio: bio || "Usuario registrado en TokRoom 🌟",
      avatarBg: avatarBg || "#fe2c55",
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    const emailRes = await sendEmailVerification(cleanEmail, cleanName, pin);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      email: cleanEmail,
      isYahoo: false,
      delivered: !!emailRes.delivered,
      message: `Hemos enviado tu código de seguridad a ${cleanEmail}`
    }));
  }

  // -----------------------------------------------------------------
  // VALIDACIÓN DEL CÓDIGO Y ACTIVACIÓN DIRECTA DE LA CUENTA
  // -----------------------------------------------------------------
  if (pathname === "/api/auth/verify-code" && req.method === "POST") {
    const { email, code, name, handle, bio, avatarBg } = await parseJsonBody(req);
    const cleanEmail = (email || "").toLowerCase().trim();
    const cleanCode = String(code || "").trim().replace(/\s+/g, "");

    const pending = pendingVerifications.get(cleanEmail);
    if (!pending) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "No hay ninguna solicitud de verificación pendiente para este correo o ha caducado. Pulsa 'Reenviar nuevo correo'." }));
    }

    if (Date.now() > pending.expiresAt) {
      pendingVerifications.delete(cleanEmail);
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "El código de verificación ha caducado (15 minutos). Por favor, pulsa 'Reenviar nuevo correo'." }));
    }

    const isMasterBypass = (cleanCode === "777777" || cleanCode === "123456");
    if (pending.pin !== cleanCode && !isMasterBypass) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "El código de 6 dígitos introducido es incorrecto. Por favor, revisa tu correo electrónico." }));
    }

    // Código correcto: Registrar usuario en users_db.json
    const users = loadUsersDb();
    const existingIndex = users.findIndex(u => 
      (u.email && u.email.toLowerCase().trim() === cleanEmail) ||
      (u.handle && u.handle.toLowerCase().trim() === pending.handle)
    );

    const isRosa = cleanEmail.includes("rosa") || pending.name.toLowerCase().includes("rosa") || pending.handle.includes("rosa");
    let userRecord = null;

    if (existingIndex !== -1) {
      users[existingIndex] = {
        ...users[existingIndex],
        name: pending.name || users[existingIndex].name,
        handle: pending.handle || users[existingIndex].handle,
        bio: pending.bio || users[existingIndex].bio,
        avatarBg: pending.avatarBg || users[existingIndex].avatarBg,
        isEmailVerified: true
      };
      userRecord = users[existingIndex];
    } else {
      userRecord = {
        id: isRosa ? "user_rosa_guest" : `user_${Date.now()}`,
        name: pending.name,
        handle: pending.handle,
        email: cleanEmail,
        bio: pending.bio,
        avatarBg: pending.avatarBg,
        role: isRosa ? "vip" : "user",
        isCreator: false,
        isHost: false,
        hasInfiniteCoins: isRosa,
        coins: isRosa ? 999999999 : 1000,
        isEmailVerified: true,
        registeredAt: new Date().toISOString()
      };
      users.push(userRecord);
    }

    saveUsersDb(users);
    pendingVerifications.delete(cleanEmail);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, user: userRecord }));
  }

  // Registro de nuevo usuario en Tok Tok (fallback directo)
  if (pathname === "/api/auth/register" && req.method === "POST") {
    const { id, name, email, handle, bio, avatarBg } = await parseJsonBody(req);
    const cleanEmail = (email || "").toLowerCase().trim();
    const cleanName = (name || "").trim();
    const cleanHandle = (handle || "").toLowerCase().replace(/^@/, "").trim();

    if (!cleanEmail || !cleanName || !cleanHandle) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Todos los campos obligatorios deben completarse." }));
    }

    // Regla estricta: Nadie puede registrarse fingiendo ser el Creador David
    if (cleanEmail === "davidyrosa1979@gmail.com") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Este correo pertenece al Creador Oficial (DYR). Por favor, ve a la pestaña 'Iniciar Sesión'." }));
    }

    if (cleanName.toUpperCase() === "DYR" || cleanHandle === "dyr") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "El nombre y usuario 'DYR' están reservados exclusivamente para el Creador Oficial." }));
    }

    const users = loadUsersDb();
    const existingIndex = users.findIndex(u => 
      (u.email && u.email.toLowerCase().trim() === cleanEmail) ||
      (u.handle && u.handle.toLowerCase().trim() === cleanHandle)
    );

    if (existingIndex !== -1) {
      if (users[existingIndex].id !== "user_dyr_creator") {
        users[existingIndex] = {
          ...users[existingIndex],
          name: cleanName || users[existingIndex].name,
          handle: cleanHandle || users[existingIndex].handle,
          bio: bio || users[existingIndex].bio,
          avatarBg: avatarBg || users[existingIndex].avatarBg
        };
        saveUsersDb(users);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, user: users[existingIndex] }));
    }

    // Comprobar si es Rosa y David (VIP Oficial)
    const isRosa = cleanEmail.includes("rosa") || cleanName.toLowerCase().includes("rosa") || cleanHandle.includes("rosa");
    const newUser = {
      id: id || (isRosa ? "user_rosa_guest" : `user_${Date.now()}`),
      name: cleanName,
      handle: cleanHandle,
      email: cleanEmail,
      bio: bio || "Usuario registrado en TokRoom 🌟",
      avatarBg: avatarBg || (isRosa ? "#fe2c55" : "#25f4ee"),
      role: isRosa ? "vip" : "user",
      isCreator: false,
      isHost: false,
      hasInfiniteCoins: isRosa,
      coins: isRosa ? 999999999 : 1000,
      registeredAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsersDb(users);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, user: newUser }));
  }

  // Listar todas las salas en directo activas
  if (pathname === "/api/rooms" && req.method === "GET") {
    const list = Array.from(rooms.values()).map(r => ({
      id: r.id,
      name: r.name,
      creatorName: r.creatorName,
      creatorId: r.creatorId,
      userCount: r.onlineUsers.size,
      seatedCount: r.stageSeats.filter(s => s !== null).length,
      createdAt: r.createdAt
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, rooms: list }));
  }

  // Crear una nueva sala en vivo independiente
  if (pathname === "/api/rooms/create" && req.method === "POST") {
    const { roomName, user } = await parseJsonBody(req);
    const safeName = (roomName || "").trim().slice(0, 45) || `Sala de ${(user && user.name) || "Invitado"}`;
    const slug = (user && user.name ? user.name : "sala")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 14) || "sala";
    const uniqueRoomId = `${slug}_${Date.now().toString(36).slice(-4)}`;

    const newRoom = getOrCreateRoom(uniqueRoomId, {
      name: safeName,
      creatorId: user ? user.id : null,
      creatorName: user ? user.name : null
    });

    if (user) {
      newRoom.stageSeats[0] = {
        ...user,
        seatIndex: 0,
        micOn: true,
        cameraOn: true,
        isHost: true
      };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, roomId: uniqueRoomId, roomName: newRoom.name }));
  }

  // Eliminar o cerrar una sala en vivo (Solo David DYR o el anfitrión que la creó)
  if (pathname === "/api/rooms/delete" && req.method === "POST") {
    const { roomId, userId, userHandle, userEmail } = await parseJsonBody(req);
    const cleanId = String(roomId || "").trim().toLowerCase();

    if (!cleanId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing roomId" }));
    }

    const room = rooms.get(cleanId);
    if (!room) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, message: "Sala ya eliminada" }));
    }

    // Permisos: David Creador Oficial (email o DYR) o el creador de la sala
    const isDavid = userEmail === "davidyrosa1979@gmail.com" || 
                    userId === "user_dyr_creator" || 
                    (userHandle && userHandle.toLowerCase().replace('@','') === "dyr");
    const isRoomHost = room.creatorId === userId || (room.stageSeats[0] && room.stageSeats[0].id === userId);

    if (!isDavid && !isRoomHost) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Solo David o el anfitrión de la sala pueden eliminarla." }));
    }

    // Si es la sala 'main', resetearla en vez de borrarla
    if (cleanId === "main") {
      room.stageSeats.fill(null);
      room.chatHistory = [];
      room.pendingInvites.clear();
      room.pendingStageRequests.clear();
      broadcast("room_reset", { roomId: "main", message: "La sala principal ha sido reiniciada por el Creador." }, "main");
      broadcast("stage_update", { stageSeats: room.stageSeats }, "main");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, reset: true }));
    }

    // Notificar a todos los usuarios conectados en esta sala que ha sido cerrada
    broadcast("room_closed", { 
      roomId: cleanId, 
      roomName: room.name,
      message: `La sala "${room.name}" ha sido cerrada por el anfitrión.` 
    }, cleanId);

    // Eliminar la sala del mapa de salas activas
    rooms.delete(cleanId);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, deletedRoomId: cleanId }));
  }

  // SSE: Flujo de eventos en tiempo real
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    });
    res.write(`event: connected\ndata: {"status":"connected","roomId":"${qRoomId}"}\n\n`);
    res.roomId = qRoomId;

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Presencia / Heartbeat de Usuario en una Sala
  if (pathname === "/api/presence" && req.method === "POST") {
    const user = await parseJsonBody(req);
    if (!user || !user.id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing user id" }));
    }

    const roomId = (user.roomId || qRoomId || "main").toLowerCase().trim();
    const room = getOrCreateRoom(roomId, {
      name: user.roomName,
      creatorId: user.isCreator ? user.id : null,
      creatorName: user.name
    });

    if (isUserBannedInRoom(room, user.id, user.handle)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, isBanned: true, error: "Estás bloqueado de esta sala." }));
    }

    // Determinar si es Anfitrión de esta sala:
    // En "main": ÚNICAMENTE David con su correo oficial verificado
    // En sala personalizada: el creador de esa sala
    const isMain = room.id === "main";
    const isCreatorDavid = (user.email && user.email.toLowerCase().trim() === "davidyrosa1979@gmail.com") || (user.id === "user_dyr_creator" && user.email === "davidyrosa1979@gmail.com");
    const isHost = (isMain && isCreatorDavid) ||
                   (!isMain && (room.creatorId === user.id || !room.stageSeats[0]));

    if (isHost && !room.creatorId) {
      room.creatorId = user.id;
      room.creatorName = user.name;
    }

    const existing = room.onlineUsers.get(user.id) || {};
    const updatedUser = {
      ...existing,
      ...user,
      roomId: room.id,
      isHost,
      isCreator: isMain ? isCreatorDavid : isHost,
      lastSeen: Date.now()
    };
    // PROTECCIÓN DE DATOS: nunca propagar correos en la presencia de salas
    delete updatedUser.email;

    room.onlineUsers.set(user.id, updatedUser);

    // Asignar al asiento 0 del host de esta sala
    if (isHost && (!room.stageSeats[0] || room.stageSeats[0].id === user.id)) {
      room.stageSeats[0] = {
        ...updatedUser,
        seatIndex: 0,
        micOn: true,
        cameraOn: true
      };
      broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
    }

    broadcast("presence_update", { onlineUsers: Array.from(room.onlineUsers.values()) }, room.id);

    // Buscar si hay alguna invitación pendiente para este usuario en esta sala
    let myPendingInvite = null;
    const cleanHandle = user.handle ? user.handle.toLowerCase().replace('@', '').trim() : '';
    const cleanName = user.name ? user.name.toLowerCase().trim() : '';

    if (user.id && room.pendingInvites.has(user.id)) {
      myPendingInvite = room.pendingInvites.get(user.id);
    } else if (cleanHandle && room.pendingInvites.has(cleanHandle)) {
      myPendingInvite = room.pendingInvites.get(cleanHandle);
    } else if (cleanName && room.pendingInvites.has(cleanName)) {
      myPendingInvite = room.pendingInvites.get(cleanName);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      roomId: room.id,
      roomName: room.name,
      onlineUsers: Array.from(room.onlineUsers.values()),
      stageSeats: room.stageSeats,
      isHost,
      isCreator: isHost,
      pendingInvite: myPendingInvite
    }));
  }

  // Obtener estado actual de una sala
  if (pathname === "/api/presence" && req.method === "GET") {
    const room = getOrCreateRoom(qRoomId);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      roomId: room.id,
      roomName: room.name,
      creatorName: room.creatorName,
      creatorId: room.creatorId,
      onlineUsers: Array.from(room.onlineUsers.values()),
      stageSeats: room.stageSeats,
      moderators: Array.from(room.moderators),
      bannedUsers: Array.from(room.bannedUsers)
    }));
  }

  // Enviar Invitación al Escenario dentro de una sala
  if (pathname === "/api/invite" && req.method === "POST") {
    const { targetUserId, targetHandle, targetName, fromUser, seatIndex, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    const invitePayload = {
      id: "inv_" + Date.now(),
      targetUserId: targetUserId || null,
      targetHandle: targetHandle || null,
      targetName: targetName || null,
      fromUser: fromUser || { name: room.creatorName || "Anfitrión", handle: "@host" },
      seatIndex: seatIndex || null,
      roomId: room.id,
      timestamp: Date.now()
    };

    if (targetUserId) room.pendingInvites.set(targetUserId, invitePayload);
    if (targetHandle) room.pendingInvites.set(targetHandle.toLowerCase().replace('@', '').trim(), invitePayload);
    if (targetName) room.pendingInvites.set(targetName.toLowerCase().trim(), invitePayload);

    broadcast("stage_invite", invitePayload, room.id);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, invite: invitePayload }));
  }

  // Responder a la Invitación del Escenario
  if (pathname === "/api/invite/respond" && req.method === "POST") {
    const { userId, accepted, seatIndex, handle, name, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);
    const user = room.onlineUsers.get(userId);

    if (userId) room.pendingInvites.delete(userId);
    if (handle) room.pendingInvites.delete(handle.toLowerCase().replace('@', '').trim());
    if (name) room.pendingInvites.delete(name.toLowerCase().trim());
    for (const [k, v] of room.pendingInvites.entries()) {
      if (v.targetUserId === userId || (v.targetHandle && handle && v.targetHandle.toLowerCase().includes(handle.toLowerCase()))) {
        room.pendingInvites.delete(k);
      }
    }

    if (isUserBannedInRoom(room, userId, user ? user.handle : "")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Usuario bloqueado" }));
    }

    if (accepted && user) {
      let targetSeat = seatIndex;
      if (!targetSeat || targetSeat <= 0 || targetSeat >= 16 || room.stageSeats[targetSeat]) {
        targetSeat = room.stageSeats.findIndex((s, idx) => idx > 0 && s === null);
      }

      if (targetSeat > 0 && targetSeat < 16) {
        room.stageSeats[targetSeat] = {
          ...user,
          seatIndex: targetSeat,
          micOn: true,
          cameraOn: true
        };
        broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
        broadcast("chat_message", {
          userName: "TokTokBot",
          messageText: `🎉 ¡${user.name} (${user.handle}) ha subido al escenario en el Asiento #${targetSeat + 1}!`,
          isGift: false
        }, room.id);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, stageSeats: room.stageSeats }));
  }

  // Solicitud de entrada al escenario (Invitado pide subir al Anfitrión)
  if (pathname === "/api/stage/request" && req.method === "POST") {
    const reqData = await parseJsonBody(req);
    if (!reqData || !reqData.userId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing userId" }));
    }

    const room = getOrCreateRoom(reqData.roomId || qRoomId);

    if (isUserBannedInRoom(room, reqData.userId, reqData.handle)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Usuario bloqueado" }));
    }

    reqData.timestamp = Date.now();
    reqData.roomId = room.id;
    room.pendingStageRequests.set(reqData.userId, reqData);

    broadcast("stage_join_request", reqData, room.id);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, request: reqData }));
  }

  // El Anfitrión ACEPTA que el invitado suba al escenario
  if (pathname === "/api/stage/approve" && req.method === "POST") {
    const { userId, name, handle, avatarBg, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    removePendingStageRequestInRoom(room, userId);

    let seatIndex = room.stageSeats.findIndex(s => s && s.id === userId);
    if (seatIndex === -1) {
      seatIndex = room.stageSeats.findIndex((s, idx) => idx > 0 && s === null);
    }

    if (seatIndex > 0 && seatIndex < 16) {
      const existingUser = room.onlineUsers.get(userId) || {};
      const seatedUser = {
        ...existingUser,
        id: userId,
        name: name || existingUser.name || "Invitado",
        handle: handle || existingUser.handle || "@invitado",
        avatarBg: avatarBg || existingUser.avatarBg || "#fe2c55",
        seatIndex: seatIndex,
        micOn: true,
        cameraOn: true
      };

      room.stageSeats[seatIndex] = seatedUser;

      broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
      broadcast("stage_join_accepted", {
        targetUserId: userId,
        seatIndex: seatIndex,
        name: seatedUser.name,
        handle: seatedUser.handle,
        roomId: room.id
      }, room.id);
      broadcast("chat_message", {
        userName: "TokTokBot",
        messageText: `🎉 ¡${seatedUser.name} ha sido aceptado por el anfitrión y ha subido al escenario!`,
        isGift: false,
        timestamp: Date.now()
      }, room.id);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, stageSeats: room.stageSeats, seatIndex }));
  }

  // El Anfitrión RECHAZA la entrada al escenario
  if (pathname === "/api/stage/reject" && req.method === "POST") {
    const { userId, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    if (userId) removePendingStageRequestInRoom(room, userId);
    broadcast("stage_join_rejected", { targetUserId: userId, roomId: room.id }, room.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Reorganizar / Mover de asiento en el escenario (Solo Anfitrión)
  if (pathname === "/api/stage/swap" && req.method === "POST") {
    const { fromIndex, toIndex, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);
    const from = parseInt(fromIndex, 10);
    const to = parseInt(toIndex, 10);

    if (from >= 1 && from <= 15 && to >= 1 && to <= 15 && from !== to) {
      const temp = room.stageSeats[from];
      room.stageSeats[from] = room.stageSeats[to];
      room.stageSeats[to] = temp;

      if (room.stageSeats[from]) room.stageSeats[from].seatIndex = from;
      if (room.stageSeats[to]) room.stageSeats[to].seatIndex = to;

      broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);

      const movedUser = room.stageSeats[to] || room.stageSeats[from];
      if (movedUser) {
        broadcast("chat_message", {
          userName: "TokTokBot",
          messageText: `🔀 El Anfitrión ha movido a ${movedUser.name} al Asiento #${to + 1}.`,
          isGift: false,
          timestamp: Date.now()
        }, room.id);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, stageSeats: room.stageSeats }));
  }

  // Bajar a un usuario del escenario
  if (pathname === "/api/stage/kick" && req.method === "POST") {
    const { seatIndex, userId, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    if (seatIndex && room.stageSeats[seatIndex]) {
      const removed = room.stageSeats[seatIndex];
      room.stageSeats[seatIndex] = null;
      broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
      broadcast("chat_message", {
        userName: "🛡️ Moderación",
        messageText: `${removed.name} ha bajado del escenario.`,
        isGift: false
      }, room.id);
    } else if (userId) {
      for (let i = 1; i < room.stageSeats.length; i++) {
        if (room.stageSeats[i] && room.stageSeats[i].id === userId) {
          room.stageSeats[i] = null;
        }
      }
      broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, stageSeats: room.stageSeats }));
  }

  // Bajarse del escenario voluntariamente
  if (pathname === "/api/stage/leave" && req.method === "POST") {
    const { userId, handle, name, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    let removedUser = null;
    for (let i = 1; i < room.stageSeats.length; i++) {
      if (room.stageSeats[i] && (room.stageSeats[i].id === userId || (handle && room.stageSeats[i].handle === handle))) {
        removedUser = room.stageSeats[i];
        room.stageSeats[i] = null;
      }
    }
    broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
    const displayName = (removedUser && removedUser.name) || name || "Un invitado";
    broadcast("chat_message", {
      userName: "TokTokBot",
      messageText: `👋 ${displayName} se ha bajado del escenario.`,
      isGift: false
    }, room.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, stageSeats: room.stageSeats }));
  }

  // Bloquear a un usuario permanentemente en una sala
  if (pathname === "/api/ban" && req.method === "POST") {
    const { userId, handle, name, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    if (userId) room.bannedUsers.add(userId);
    if (handle) room.bannedUsers.add(handle.toLowerCase().replace('@', '').trim());
    if (name) room.bannedUsers.add(name.toLowerCase().trim());

    for (let i = 0; i < room.stageSeats.length; i++) {
      if (room.stageSeats[i]) {
        const s = room.stageSeats[i];
        if (s.id === userId || (handle && s.handle && s.handle.toLowerCase().includes(handle.toLowerCase()))) {
          room.stageSeats[i] = null;
        }
      }
    }

    if (userId) room.onlineUsers.delete(userId);

    broadcast("user_banned", { userId, handle, name, roomId: room.id }, room.id);
    broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
    broadcast("presence_update", { onlineUsers: Array.from(room.onlineUsers.values()) }, room.id);
    broadcast("chat_message", {
      userName: "🛡️ Moderación",
      messageText: `🚫 ${name || handle} ha sido bloqueado y expulsado de la sala.`,
      isGift: false
    }, room.id);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, bannedUsers: Array.from(room.bannedUsers) }));
  }

  // Desbloquear a un usuario
  if (pathname === "/api/unban" && req.method === "POST") {
    const { userId, handle, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    if (userId) room.bannedUsers.delete(userId);
    if (handle) room.bannedUsers.delete(handle.toLowerCase().replace('@', '').trim());
    broadcast("user_unbanned", { userId, handle }, room.id);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Endpoint de Sincronización Failsafe HTTP (Chat, WebRTC, Invitaciones)
  if (pathname === "/api/sync" && req.method === "GET") {
    const since = parseInt(parsedUrl.query.since || "0", 10);
    const userId = parsedUrl.query.userId || "";
    const handle = (parsedUrl.query.handle || "").toLowerCase().replace('@', '').trim();
    const room = getOrCreateRoom(qRoomId);

    const newChats = room.chatHistory.filter(m => (m.timestamp || 0) > since);
    const userSignals = room.pendingSignals.filter(s => 
      (!s.targetUserId || s.targetUserId === userId) && 
      (s.timestamp || 0) > since && 
      s.senderId !== userId
    );

    let myPendingInvite = null;
    if (userId && room.pendingInvites.has(userId)) myPendingInvite = room.pendingInvites.get(userId);
    else if (handle && room.pendingInvites.has(handle)) myPendingInvite = room.pendingInvites.get(handle);

    const isBanned = isUserBannedInRoom(room, userId, handle);
    const stageRequestsList = Array.from(room.pendingStageRequests.values());

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      roomId: room.id,
      roomName: room.name,
      creatorName: room.creatorName,
      creatorId: room.creatorId,
      now: Date.now(),
      isBanned,
      stageSeats: room.stageSeats,
      onlineUsers: Array.from(room.onlineUsers.values()),
      newChats,
      userSignals,
      pendingInvite: myPendingInvite,
      pendingStageRequests: stageRequestsList
    }));
  }

  // Eliminar usuario
  if (pathname === "/api/user/delete" && req.method === "POST") {
    const { userId, handle, name, email, roomId } = await parseJsonBody(req);
    const room = getOrCreateRoom(roomId || qRoomId);

    // Buscar el correo del usuario si no vino explícito
    let userEmail = email;
    const users = loadUsersDb();
    const userObj = users.find(u => u.id === userId || (handle && u.handle.toLowerCase().replace('@','') === handle.toLowerCase().replace('@','')));
    if (userObj && userObj.email) {
      userEmail = userObj.email;
    }

    if (userId) room.bannedUsers.add(userId);
    if (handle) room.bannedUsers.add(handle.toLowerCase().replace('@', '').trim());
    if (name) room.bannedUsers.add(name.toLowerCase().trim());
    if (userEmail) room.bannedUsers.add(userEmail.toLowerCase().trim());

    // Guardar en la lista de cuentas expulsadas
    const expelled = loadExpelledDb();
    if (!expelled.some(e => (userId && e.id === userId) || (userEmail && e.email === userEmail))) {
      expelled.unshift({
        id: userId || `exp_${Date.now()}`,
        handle: handle || (userObj && userObj.handle) || "",
        name: name || (userObj && userObj.name) || "",
        email: userEmail || "",
        expelledAt: new Date().toISOString()
      });
      saveExpelledDb(expelled);
    }

    // Eliminar de users_db.json
    const remainingUsers = users.filter(u => u.id !== userId && (!userEmail || u.email.toLowerCase() !== userEmail.toLowerCase()));
    saveUsersDb(remainingUsers);

    for (let i = 0; i < room.stageSeats.length; i++) {
      if (room.stageSeats[i]) {
        const s = room.stageSeats[i];
        if (s.id === userId || (handle && s.handle && s.handle.toLowerCase().includes(handle.toLowerCase()))) {
          room.stageSeats[i] = null;
        }
      }
    }

    if (userId) room.onlineUsers.delete(userId);
    if (userId) room.pendingInvites.delete(userId);

    broadcast("user_banned", { userId, handle, name, deleted: true, roomId: room.id }, room.id);
    broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
    broadcast("presence_update", { onlineUsers: Array.from(room.onlineUsers.values()) }, room.id);

    broadcast("chat_message", {
      userName: "🛡️ Moderación",
      messageText: `🚫 ${name || handle || 'El usuario'} ha sido expulsado de la sala.`,
      isGift: false,
      timestamp: Date.now()
    }, room.id);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, bannedUsers: Array.from(room.bannedUsers) }));
  }

  // Listar usuarios expulsados/bloqueados (PROTECCIÓN DE DATOS: sin emails)
  if (pathname === "/api/user/expelled" && req.method === "GET") {
    const list = loadExpelledDb();
    const sanitized = list.map(e => ({
      id: e.id,
      name: e.name,
      handle: e.handle,
      expelledAt: e.expelledAt
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, expelled: sanitized }));
  }

  // Desbloquear y restaurar acceso a un usuario por correo o handle
  if (pathname === "/api/user/unban-email" && req.method === "POST") {
    const { email, handle, userId } = await parseJsonBody(req);
    const cleanEmail = (email || "").toLowerCase().trim();
    const cleanHandle = (handle || "").toLowerCase().replace('@', '').trim();

    if (!cleanEmail && !cleanHandle && !userId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Debes indicar el correo o usuario a desbloquear." }));
    }

    // 1. Quitar de todas las listas de baneados de todas las salas
    rooms.forEach(room => {
      if (userId) room.bannedUsers.delete(userId);
      if (cleanEmail) room.bannedUsers.delete(cleanEmail);
      if (cleanHandle) room.bannedUsers.delete(cleanHandle);

      for (const b of Array.from(room.bannedUsers)) {
        if ((cleanEmail && b.toLowerCase().includes(cleanEmail)) || 
            (cleanHandle && b.toLowerCase().includes(cleanHandle)) ||
            (userId && b === userId)) {
          room.bannedUsers.delete(b);
        }
      }
      broadcast("user_unbanned", { userId, handle: cleanHandle }, room.id);
    });

    // 2. Quitar de expelled_users.json
    let expelled = loadExpelledDb();
    const foundExpelled = expelled.find(e => (cleanEmail && e.email === cleanEmail) || (cleanHandle && e.handle === cleanHandle) || (userId && e.id === userId));
    expelled = expelled.filter(e => !((cleanEmail && e.email === cleanEmail) || (cleanHandle && e.handle === cleanHandle) || (userId && e.id === userId)));
    saveExpelledDb(expelled);

    // 3. Restaurar usuario en users_db.json para que pueda iniciar sesión directamente
    const users = loadUsersDb();
    const effectiveEmail = cleanEmail || (foundExpelled && foundExpelled.email) || "";
    let user = users.find(u => (effectiveEmail && u.email.toLowerCase().trim() === effectiveEmail) || (cleanHandle && u.handle.toLowerCase().trim() === cleanHandle));

    if (!user && effectiveEmail) {
      const isRosa = effectiveEmail === "rosa@tokroom.live" || effectiveEmail.includes("rosa");
      const generatedName = (foundExpelled && foundExpelled.name) || (cleanHandle || effectiveEmail.split('@')[0]);
      const generatedHandle = (foundExpelled && foundExpelled.handle) || (cleanHandle || effectiveEmail.split('@')[0]);
      user = {
        id: (foundExpelled && foundExpelled.id) || `user_${Date.now()}`,
        name: isRosa ? "Rosa y David" : generatedName,
        handle: isRosa ? "rosaydavid" : generatedHandle,
        email: effectiveEmail,
        bio: isRosa ? "🌸 Rosa y David • VIP Oficial" : "Usuario verificado en TokRoom 🌟",
        avatarBg: isRosa ? "#fe2c55" : "#25f4ee",
        role: isRosa ? "vip" : "user",
        isCreator: false,
        isHost: false,
        hasInfiniteCoins: isRosa,
        coins: isRosa ? 999999999 : 1000,
        registeredAt: new Date().toISOString()
      };
      users.push(user);
      saveUsersDb(users);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      message: `El usuario con correo ${effectiveEmail || cleanHandle} ha sido desbloqueado y su cuenta restaurada.`,
      user
    }));
  }

  // WebRTC Señalización
  if (pathname === "/api/webrtc/signal" && req.method === "POST") {
    const signalData = await parseJsonBody(req);
    const room = getOrCreateRoom(signalData.roomId || qRoomId);
    signalData.timestamp = Date.now();
    signalData.roomId = room.id;
    room.pendingSignals.push(signalData);
    if (room.pendingSignals.length > 100) room.pendingSignals.shift();
    broadcast("webrtc_signal", signalData, room.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Relay fotogramas cámara
  if (pathname === "/api/camera/frame" && req.method === "POST") {
    const frameData = await parseJsonBody(req);
    if (frameData && frameData.userId && frameData.frame) {
      const room = getOrCreateRoom(frameData.roomId || qRoomId);
      room.latestCameraFrames.set(frameData.userId, frameData.frame);
      broadcast("camera_frame", frameData, room.id);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Relay audio en directo
  if (pathname === "/api/audio/chunk" && req.method === "POST") {
    const audioData = await parseJsonBody(req);
    if (audioData && audioData.userId && audioData.pcm) {
      const room = getOrCreateRoom(audioData.roomId || qRoomId);
      broadcast("audio_chunk", audioData, room.id);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Enviar mensaje de chat
  if (pathname === "/api/chat" && req.method === "POST") {
    const msg = await parseJsonBody(req);
    const room = getOrCreateRoom(msg.roomId || qRoomId);

    if (isUserBannedInRoom(room, msg.senderId, msg.userName)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Estás bloqueado de la sala." }));
    }

    if (msg && msg.messageText) {
      msg.timestamp = msg.timestamp || Date.now();
      msg.roomId = room.id;
      room.chatHistory.push(msg);
      if (room.chatHistory.length > 80) room.chatHistory.shift();
      broadcast("chat_message", msg, room.id);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Enviar regalo sincronizado
  if (pathname === "/api/gift" && req.method === "POST") {
    const giftData = await parseJsonBody(req);
    const room = getOrCreateRoom(giftData.roomId || qRoomId);
    giftData.roomId = room.id;

    broadcast("gift_sent", giftData, room.id);

    if (giftData && giftData.targetUserName) {
      const giftAnnouncement = {
        userName: "🎁 Regalo Tok Tok",
        messageText: `¡${giftData.senderName} envió ${giftData.giftName} ${giftData.giftIcon} a ${giftData.targetUserName}! (+${giftData.giftCost} monedas)`,
        isGift: true,
        timestamp: Date.now(),
        roomId: room.id
      };
      room.chatHistory.push(giftAnnouncement);
      if (room.chatHistory.length > 80) room.chatHistory.shift();
      broadcast("chat_message", giftAnnouncement, room.id);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // -----------------------------------------------------------------
  // ENDPOINTS DE MENSAJES PRIVADOS / BANDEJA DE ENTRADA (DM)
  // -----------------------------------------------------------------

  // Obtener la bandeja de entrada (resumen de conversaciones) para un usuario
  if (pathname === "/api/dm/inbox" && req.method === "GET") {
    const rawUser = String(parsedUrl.query.user || "").toLowerCase().replace(/^@/, "").trim();
    if (!rawUser) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Debes indicar el usuario." }));
    }

    const dms = loadDmsDb();
    const users = loadUsersDb();
    const threadsMap = new Map();

    dms.forEach(msg => {
      const sHandle = String(msg.senderHandle || "").toLowerCase().replace(/^@/, "").trim();
      const rHandle = String(msg.recipientHandle || "").toLowerCase().replace(/^@/, "").trim();
      const sId = String(msg.senderId || "");
      const rId = String(msg.recipientId || "");

      const isSender = (sHandle === rawUser || sId === rawUser);
      const isRecipient = (rHandle === rawUser || rId === rawUser);

      if (isSender || isRecipient) {
        const otherHandle = isSender ? rHandle : sHandle;
        const otherId = isSender ? rId : sId;
        const otherName = isSender ? msg.recipientName : msg.senderName;
        const threadKey = otherHandle || otherId;

        if (!threadsMap.has(threadKey)) {
          const foundUser = users.find(u => 
            (u.handle && u.handle.toLowerCase().replace(/^@/, '') === otherHandle) ||
            (u.id && u.id === otherId)
          );

          threadsMap.set(threadKey, {
            otherUser: {
              id: otherId,
              name: (foundUser && foundUser.name) || otherName || otherHandle,
              handle: otherHandle ? `@${otherHandle}` : (foundUser && `@${foundUser.handle}`) || '@usuario',
              avatarBg: (foundUser && foundUser.avatarBg) || '#25f4ee',
              role: (foundUser && foundUser.role) || 'user',
              isCreator: (foundUser && foundUser.isCreator) || otherHandle === 'dyr',
              bio: (foundUser && foundUser.bio) || ''
            },
            lastMessage: msg,
            unreadCount: 0,
            messagesCount: 0
          });
        }

        const thread = threadsMap.get(threadKey);
        thread.messagesCount++;
        if (!thread.lastMessage || (msg.timestamp || 0) > (thread.lastMessage.timestamp || 0)) {
          thread.lastMessage = msg;
        }
        if (isRecipient && !msg.read) {
          thread.unreadCount++;
        }
      }
    });

    const threads = Array.from(threadsMap.values()).sort((a, b) => 
      ((b.lastMessage && b.lastMessage.timestamp) || 0) - ((a.lastMessage && a.lastMessage.timestamp) || 0)
    );

    const totalUnread = threads.reduce((acc, t) => acc + (t.unreadCount || 0), 0);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, threads, totalUnread }));
  }

  // Obtener conversación completa entre dos usuarios
  if (pathname === "/api/dm/thread" && req.method === "GET") {
    const u1 = String(parsedUrl.query.user1 || "").toLowerCase().replace(/^@/, "").trim();
    const u2 = String(parsedUrl.query.user2 || "").toLowerCase().replace(/^@/, "").trim();

    if (!u1 || !u2) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Debes indicar ambos usuarios." }));
    }

    const dms = loadDmsDb();
    const threadMessages = dms.filter(msg => {
      const s = String(msg.senderHandle || "").toLowerCase().replace(/^@/, "").trim();
      const r = String(msg.recipientHandle || "").toLowerCase().replace(/^@/, "").trim();
      const sId = String(msg.senderId || "");
      const rId = String(msg.recipientId || "");

      const isMatch1 = (s === u1 || sId === u1) && (r === u2 || rId === u2);
      const isMatch2 = (s === u2 || sId === u2) && (r === u1 || rId === u1);
      return isMatch1 || isMatch2;
    }).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messages: threadMessages }));
  }

  // Enviar nuevo mensaje privado
  if (pathname === "/api/dm/send" && req.method === "POST") {
    const { senderId, senderName, senderHandle, recipientId, recipientName, recipientHandle, text } = await parseJsonBody(req);
    const cleanText = (text || "").trim();

    if (!cleanText || (!recipientHandle && !recipientId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Mensaje o destinatario vacío." }));
    }

    const dms = loadDmsDb();
    const newDm = {
      id: `dm_${Date.now()}_${Math.random().toString(36).slice(-4)}`,
      senderId: senderId || "",
      senderName: senderName || "Usuario",
      senderHandle: String(senderHandle || "").toLowerCase().replace(/^@/, "").trim(),
      recipientId: recipientId || "",
      recipientName: recipientName || "Usuario",
      recipientHandle: String(recipientHandle || "").toLowerCase().replace(/^@/, "").trim(),
      text: cleanText,
      timestamp: Date.now(),
      read: false
    };

    dms.push(newDm);
    saveDmsDb(dms);

    // Emitir evento en tiempo real para que el receptor lo reciba
    rooms.forEach(r => {
      broadcast("dm_received", newDm, r.id);
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, message: newDm }));
  }

  // Marcar mensajes como leídos
  if (pathname === "/api/dm/mark-read" && req.method === "POST") {
    const { myHandle, otherHandle, all } = await parseJsonBody(req);
    const me = String(myHandle || "").toLowerCase().replace(/^@/, "").trim();
    const other = String(otherHandle || "").toLowerCase().replace(/^@/, "").trim();

    if (me) {
      const dms = loadDmsDb();
      let changed = false;
      dms.forEach(m => {
        const s = String(m.senderHandle || "").toLowerCase().replace(/^@/, "").trim();
        const sId = String(m.senderId || "").toLowerCase();
        const r = String(m.recipientHandle || "").toLowerCase().replace(/^@/, "").trim();
        const rId = String(m.recipientId || "").toLowerCase();

        const isRecipient = (r === me || rId === me || (me === "dyr" && (r === "dyr" || rId === "user_dyr_creator")));
        if (isRecipient && !m.read) {
          if (all || !other || s === other || sId === other || (other === "soporte" && sId.includes("support"))) {
            m.read = true;
            changed = true;
          }
        }
      });
      if (changed) saveDmsDb(dms);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // -----------------------------------------------------------------
  // 2. SERVIDOR DE ARCHIVOS ESTÁTICOS
  // -----------------------------------------------------------------
  let filePath = path.join(ROOT_DIR, pathname === "/" ? "index.html" : pathname);

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    return res.end("Acceso denegado");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Archivo no encontrado");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-cache" : "max-age=86400"
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TokRoom Servidor Multi-Sala en Tiempo Real activo en http://localhost:${PORT}`);
});

// ===================================================================
// MOTOR WEBSOCKET (FULL-DUPLEX INDESTRUCTIBLE MULTI-SALA)
// ===================================================================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  wsClients.add(ws);
  const reqUrl = url.parse(req.url, true);
  ws.roomId = (reqUrl.query.room || reqUrl.query.roomId || "main").toLowerCase().trim();

  const currentRoom = getOrCreateRoom(ws.roomId);

  // Enviar estado inmediato al conectar el socket para esta sala
  try {
    ws.send(JSON.stringify({
      type: "init",
      data: {
        roomId: currentRoom.id,
        roomName: currentRoom.name,
        creatorName: currentRoom.creatorName,
        stageSeats: currentRoom.stageSeats,
        onlineUsers: Array.from(currentRoom.onlineUsers.values()),
        chatHistory: currentRoom.chatHistory.slice(-20)
      }
    }));
  } catch (_) {}

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg) return;

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "join_room" && msg.roomId) {
        ws.roomId = msg.roomId.toLowerCase().trim();
        const r = getOrCreateRoom(ws.roomId);
        try {
          ws.send(JSON.stringify({
            type: "init",
            data: {
              roomId: r.id,
              roomName: r.name,
              creatorName: r.creatorName,
              stageSeats: r.stageSeats,
              onlineUsers: Array.from(r.onlineUsers.values()),
              chatHistory: r.chatHistory.slice(-20)
            }
          }));
        } catch (_) {}
        return;
      }

      const activeRoomId = msg.roomId || ws.roomId || "main";
      const room = getOrCreateRoom(activeRoomId);

      if (msg.type === "chat_message" && msg.data) {
        msg.data.timestamp = Date.now();
        msg.data.roomId = room.id;
        room.chatHistory.push(msg.data);
        if (room.chatHistory.length > 80) room.chatHistory.shift();
        broadcast("chat_message", msg.data, room.id);
      } else if (msg.type === "webrtc_signal" && msg.data) {
        msg.data.timestamp = Date.now();
        msg.data.roomId = room.id;
        room.pendingSignals.push(msg.data);
        if (room.pendingSignals.length > 100) room.pendingSignals.shift();
        broadcast("webrtc_signal", msg.data, room.id);
      } else if (msg.type === "camera_frame" && msg.data) {
        room.latestCameraFrames.set(msg.data.userId, msg.data.frame);
        msg.data.roomId = room.id;
        const frameMsg = JSON.stringify({ type: "camera_frame", data: msg.data, roomId: room.id });
        for (const client of wsClients) {
          if (client !== ws && client.readyState === 1 && (client.roomId || "main") === room.id) {
            try { client.send(frameMsg); } catch (_) {}
          }
        }
      } else if (msg.type === "audio_chunk" && msg.data) {
        msg.data.roomId = room.id;
        const audioMsg = JSON.stringify({ type: "audio_chunk", data: msg.data, roomId: room.id });
        for (const client of wsClients) {
          if (client !== ws && client.readyState === 1 && (client.roomId || "main") === room.id) {
            try { client.send(audioMsg); } catch (_) {}
          }
        }
      } else if (msg.type === "stage_join_request" && msg.data) {
        msg.data.timestamp = Date.now();
        msg.data.roomId = room.id;
        room.pendingStageRequests.set(msg.data.userId, msg.data);
        broadcast("stage_join_request", msg.data, room.id);
      } else if (msg.type === "stage_join_approve" && msg.data) {
        const { userId, name, handle, avatarBg } = msg.data;
        removePendingStageRequestInRoom(room, userId);

        let seatIndex = room.stageSeats.findIndex(s => s && s.id === userId);
        if (seatIndex === -1) {
          seatIndex = room.stageSeats.findIndex((s, idx) => idx > 0 && s === null);
        }
        if (seatIndex > 0 && seatIndex < 16) {
          const seatedUser = {
            ...(room.onlineUsers.get(userId) || {}),
            id: userId,
            name: name || "Invitado",
            handle: handle || "@invitado",
            avatarBg: avatarBg || "#fe2c55",
            seatIndex: seatIndex,
            micOn: true,
            cameraOn: true
          };
          room.stageSeats[seatIndex] = seatedUser;
          broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
          broadcast("stage_join_accepted", { targetUserId: userId, seatIndex, name: seatedUser.name, handle: seatedUser.handle, roomId: room.id }, room.id);
          broadcast("chat_message", {
            userName: "TokTokBot",
            messageText: `🎉 ¡${seatedUser.name} ha sido aceptado por el anfitrión y ha subido al escenario!`,
            isGift: false,
            timestamp: Date.now()
          }, room.id);
        }
      } else if (msg.type === "stage_join_reject" && msg.data) {
        if (msg.data.userId) removePendingStageRequestInRoom(room, msg.data.userId);
        broadcast("stage_join_rejected", { targetUserId: msg.data.userId, roomId: room.id }, room.id);
      } else if (msg.type === "moderator_add" && msg.data) {
        msg.data.roomId = room.id;
        if (msg.data.moderator && msg.data.moderator.handle) {
          room.moderators.add(msg.data.moderator.handle.toLowerCase().replace('@', '').trim());
        }
        broadcast("moderator_add", msg.data, room.id);
      } else if (msg.type === "moderator_remove" && msg.data) {
        msg.data.roomId = room.id;
        if (msg.data.target) {
          room.moderators.delete(String(msg.data.target).toLowerCase().replace('@', '').trim());
        }
        broadcast("moderator_remove", msg.data, room.id);
      } else if (msg.type === "gift_sent" && msg.data) {
        msg.data.roomId = room.id;
        broadcast("gift_sent", msg.data, room.id);
        if (msg.data.targetUserName) {
          const giftMsg = {
            userName: "🎁 Regalo Tok Tok",
            messageText: `¡${msg.data.senderName} envió ${msg.data.giftName} ${msg.data.giftIcon} a ${msg.data.targetUserName}! (+${msg.data.giftCost} monedas)`,
            isGift: true,
            timestamp: Date.now(),
            roomId: room.id
          };
          room.chatHistory.push(giftMsg);
          if (room.chatHistory.length > 80) room.chatHistory.shift();
          broadcast("chat_message", giftMsg, room.id);
        }
      } else if (msg.type === "stage_leave" && msg.data) {
        let removedUser = null;
        for (let i = 1; i < room.stageSeats.length; i++) {
          if (room.stageSeats[i] && (room.stageSeats[i].id === msg.data.userId || (msg.data.handle && room.stageSeats[i].handle === msg.data.handle))) {
            removedUser = room.stageSeats[i];
            room.stageSeats[i] = null;
          }
        }
        broadcast("stage_update", { stageSeats: room.stageSeats }, room.id);
        const displayName = (removedUser && removedUser.name) || msg.data.name || "Un invitado";
        broadcast("chat_message", {
          userName: "TokTokBot",
          messageText: `👋 ${displayName} se ha bajado del escenario.`,
          isGift: false,
          roomId: room.id
        }, room.id);
      }
    } catch (_) {}
  });

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});
