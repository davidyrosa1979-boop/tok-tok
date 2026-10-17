/**
 * ===================================================================
 * TOK TOK - APLICACIÓN DE SALAS EN VIVO CON USUARIOS REGISTRADOS
 * Soporte para hasta 16 participantes (1 Anfitrión + 15 Invitados)
 * ===================================================================
 */

// Claves de almacenamiento local
const STORAGE_KEY_USERS = "toktok_registered_users_v1";
const STORAGE_KEY_PROFILE = "toktok_local_profile_v2";
const STORAGE_KEY_REGISTERED = "toktok_user_registered_v2";

// Estado Global de la Aplicación
const TokTokState = {
  room: {
    title: "Sala de TokRoom • DYR (Creador Oficial) en Vivo",
    viewers: 1240,
    diamonds: 14850,
    likes: 14200,
    userCoins: 999999999,
    maxGuestSeats: 15, // 15 asientos de invitados (+ 1 anfitrión = 16 asientos máx)
    isJoinedRoom: false
  },
  roomId: (new URLSearchParams(window.location.search).get("room") || new URLSearchParams(window.location.search).get("roomId") || "main").toLowerCase().trim(),
  roomName: (new URLSearchParams(window.location.search).get("room") || new URLSearchParams(window.location.search).get("roomId") || "main").toLowerCase().trim() === "main" ? "Sala Oficial DYR" : `Sala ${new URLSearchParams(window.location.search).get("room") || new URLSearchParams(window.location.search).get("roomId")}`,
  localUser: {
    id: null,
    name: "Invitado",
    handle: "invitado",
    email: "",
    avatarBg: "#fe2c55",
    isHost: false,
    isCreator: false,
    hasInfiniteCoins: false,
    cameraOn: true,
    micOn: true,
    isSpeaking: false,
    activeFilter: "none",
    mediaStream: null,
    audioContext: null,
    analyser: null
  },
  // INVITADOS EN ESCENARIO (Inicia completamente vacío: 0 invitados)
  guestsOnStage: [],
  stageSeats: new Array(16).fill(null),
  movingFromSeatIndex: null, // Asiento origen seleccionado para mover (Solo Host)
  
  // Base de datos de Usuarios Registrados
  registeredUsers: [],

  // Peticiones de Live pendientes
  pendingRequests: [],

  // Panel de Moderación y Normas del Anfitrión
  moderation: {
    isRoomLocked: false,
    isChatMuted: false,
    bannedUserIds: [],
    moderators: []
  },

  // Catálogo de Regalos Interactivos TokRoom
  gifts: [
    { id: "rose", name: "Rosa Tok", icon: "🌹", cost: 1, soundType: "pop" },
    { id: "heart_me", name: "Corazón Me", icon: "💖", cost: 10, soundType: "chime" },
    { id: "glove", name: "Manopla Batalla", icon: "🥊", cost: 25, soundType: "pop" },
    { id: "fire", name: "Fuego Pro", icon: "🔥", cost: 50, soundType: "fanfare" },
    { id: "disco", name: "Bola Disco", icon: "🪩", cost: 199, soundType: "disco" },
    { id: "rocket", name: "Cohete VIP", icon: "🚀", cost: 599, soundType: "rocket" },
    { id: "galaxy", name: "Galaxia TokTok", icon: "🌌", cost: 1000, soundType: "magic" },
    { id: "lion", name: "León Imperial", icon: "🦁", cost: 2999, soundType: "roar" },
    { id: "crown", name: "Corona Diamante", icon: "👑", cost: 5000, soundType: "fanfare" }
  ],
  giftComboCount: 0,
  lastGiftTime: 0
};

// ===================================================================
// INTERCEPTOR GLOBAL HTTP FETCH PARA MULTI-SALA
// ===================================================================
const originalFetch = window.fetch;
window.fetch = function(input, init) {
  try {
    const roomId = (TokTokState && TokTokState.roomId) ? TokTokState.roomId : "main";
    if (typeof input === "string" && input.startsWith("/api/")) {
      if (!input.includes("roomId=")) {
        input += (input.includes("?") ? "&" : "?") + `roomId=${encodeURIComponent(roomId)}`;
      }
      if (init && init.body && typeof init.body === "string") {
        try {
          const parsed = JSON.parse(init.body);
          if (parsed && typeof parsed === "object" && !parsed.roomId) {
            parsed.roomId = roomId;
            init.body = JSON.stringify(parsed);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return originalFetch.apply(this, arguments);
};

// ===================================================================
// SISTEMA DE FILTRO DE PALABRAS SOECES / NORMAS DE LA COMUNIDAD
// ===================================================================
const PROFANITY_LIST = [
  "puta", "puto", "mierda", "cabron", "cabrona", "gilipollas", "coño", "joder", "polla", "poya",
  "pendejo", "pendeja", "maricon", "maricona", "hdp", "zorra", "zorro", "imbecil", "estupido",
  "estupida", "tarado", "tarada", "bastardo", "malparido", "verga", "culiao", "mamahuevo", "conchetumadre",
  "fuck", "shit", "bitch", "asshole", "cunt", "dick", "faggot", "whore", "bastard"
];

function containsProfanity(text) {
  if (!text) return false;
  const clean = text.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[@#$_-]/g, "");

  return PROFANITY_LIST.some(badWord => {
    // Coincidencia exacta o dentro de palabras
    return clean.includes(badWord);
  });
}

function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

function isUserRegistered() {
  return localStorage.getItem(STORAGE_KEY_REGISTERED) === "true";
}

// Helper: Determinar si un usuario es VIP con Monedas Infinitas (David Creador y Rosa su mujer)
function isVipInfiniteUser(user) {
  if (!user) return false;
  const email = (user.email || "").toLowerCase().trim();

  // David / DYR (Creador Oficial) - EXCLUSIVO por correo oficial
  if (email === "davidyrosa1979@gmail.com") {
    return true;
  }

  // Rosa / Rosa y David (Mujer de David - VIP Oficial)
  if (
    email === "rosa@tokroom.live" ||
    email.includes("rosa") ||
    (user.role === "vip" && (user.name || "").toLowerCase().includes("rosa"))
  ) {
    return true;
  }

  return false;
}

// Helper: Comprobar si un usuario está dentro del escenario (Host o en uno de los 15 asientos de invitados)
function isUserOnStage(userId = TokTokState.localUser.id) {
  if (!userId) return false;
  const cleanId = String(userId).toLowerCase().trim();

  // 1. El Anfitrión de la sala siempre está en el Asiento 0
  if (TokTokState.stageSeats && TokTokState.stageSeats[0]) {
    const hostSeat = TokTokState.stageSeats[0];
    if (hostSeat.id === userId || (hostSeat.handle && hostSeat.handle.toLowerCase().replace('@','') === cleanId.replace('@',''))) {
      return true;
    }
  }
  if (userId === TokTokState.localUser.id && TokTokState.localUser.isHost) {
    return true;
  }
  if (TokTokState.roomId === "main" && (cleanId === "user_dyr_creator" || cleanId === "dyr")) {
    return true;
  }

  // 2. Cualquier invitado está en el escenario ÚNICAMENTE si está en la lista de invitados aceptados
  if (TokTokState.guestsOnStage && TokTokState.guestsOnStage.length > 0) {
    const found = TokTokState.guestsOnStage.some(g => {
      if (!g) return false;
      const gId = String(g.id || "").toLowerCase().trim();
      const gHandle = String(g.handle || "").toLowerCase().replace('@', '').trim();
      const target = cleanId.replace('@', '');
      return gId === target || (gHandle && gHandle === target);
    });
    if (found) return true;
  }

  return false;
}

// ===================================================================
// GESTIÓN DE USUARIOS REGISTRADOS EN TOK TOK (+18) (SOLO USUARIOS REALES)
// ===================================================================
const INITIAL_REGISTERED_USERS = [];

function loadRegisteredUsers() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_USERS);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Eliminar definitivamente todos los bots simulados antiguos
      TokTokState.registeredUsers = Array.isArray(parsed) 
        ? parsed.filter(u => u && u.id && !u.id.startsWith("u_")) 
        : [];
      TokTokState.registeredUsers.forEach(u => { delete u.email; });
    } else {
      TokTokState.registeredUsers = [];
    }
  } catch (e) {
    TokTokState.registeredUsers = [];
  }

  // Sincronizar usuarios reales con el servidor (PROTECCIÓN RGPD: nunca almacenar correos de otros)
  fetch("/api/users")
    .then(r => r.json())
    .then(data => {
      if (data && data.ok && Array.isArray(data.users)) {
        const map = new Map();
        data.users.forEach(u => {
          delete u.email;
          map.set(u.id || u.handle, u);
        });
        TokTokState.registeredUsers.forEach(u => {
          delete u.email;
          const key = u.id || u.handle;
          if (!map.has(key)) map.set(key, u);
        });
        TokTokState.registeredUsers = Array.from(map.values());
        saveRegisteredUsers();
        renderRegisteredUsersDirectory();
      }
    })
    .catch(() => {});

  saveRegisteredUsers();
}

function saveRegisteredUsers() {
  try {
    localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(TokTokState.registeredUsers));
  } catch (e) {
    console.error("Error guardando usuarios registrados:", e);
  }
}

function loadLocalProfile() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const forceCreator = urlParams.get("creator") === "1" || urlParams.get("creator") === "true";
    const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

    const saved = localStorage.getItem(STORAGE_KEY_PROFILE);
    if (saved) {
      const data = JSON.parse(saved);
      // REGLA ESTRICTA DE SEGURIDAD: Solo el correo oficial verificado es Creador
      const isCreator = (data.email && data.email.toLowerCase().trim() === "davidyrosa1979@gmail.com");
      const isVip = isCreator || isVipInfiniteUser(data);
      const isRosa = !isCreator && isVip;
      const myRooms = JSON.parse(localStorage.getItem("toktok_my_created_rooms") || "[]");
      const isCustomRoomHost = (TokTokState.roomId !== "main") && (myRooms.includes(TokTokState.roomId) || urlParams.get("host") === "1");

      TokTokState.localUser.id = isCreator ? "user_dyr_creator" : (isRosa ? "user_rosa_guest" : (data.id || `user_${Date.now()}`));
      TokTokState.localUser.name = isCreator ? "DYR" : (isRosa ? "Rosa y David" : (data.name || "Invitado"));
      TokTokState.localUser.handle = isCreator ? "dyr" : (isRosa ? "rosaydavid" : (data.handle || "invitado"));
      TokTokState.localUser.email = isCreator ? "davidyrosa1979@gmail.com" : (data.email || "");
      TokTokState.localUser.avatarBg = data.avatarBg || (isCreator ? "linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)" : "#fe2c55");
      TokTokState.localUser.isHost = isCreator || isCustomRoomHost;
      TokTokState.localUser.isCreator = isCreator || isCustomRoomHost;
      TokTokState.localUser.hasInfiniteCoins = isVip;

      if (isVip) {
        TokTokState.room.userCoins = 999999999;
      } else {
        const savedCoins = localStorage.getItem("toktok_user_coins");
        TokTokState.room.userCoins = savedCoins ? parseInt(savedCoins, 10) : 1000;
      }
    } else {
      // Sin sesión iniciada: Inicializar como visitante no autenticado (requiere Iniciar Sesión o Registrarse)
      const guestId = `user_${Date.now()}`;
      TokTokState.localUser.id = guestId;
      TokTokState.localUser.name = "Invitado";
      TokTokState.localUser.handle = `invitado_${guestId.slice(-4)}`;
      TokTokState.localUser.email = "";
      TokTokState.localUser.isHost = false;
      TokTokState.localUser.isCreator = false;
      TokTokState.localUser.hasInfiniteCoins = false;
      TokTokState.room.userCoins = 1000; // 1,000 monedas estándar
    }
  } catch (e) {
    console.error("Error en loadLocalProfile:", e);
  }

  updateProfileHeaderUI();
  updateCoinsDisplay();
  updateModeratorAccessUI();
}

function saveLocalProfile(name, handle, email) {
  TokTokState.localUser.name = name;
  TokTokState.localUser.handle = handle.startsWith("@") ? handle.substring(1) : handle;
  if (email) TokTokState.localUser.email = email;

  const isCreator = (email && email.toLowerCase().trim() === "davidyrosa1979@gmail.com");
  const isVip = isCreator || isVipInfiniteUser({ name, handle, email });
  TokTokState.localUser.isCreator = isCreator;
  TokTokState.localUser.hasInfiniteCoins = isVip;
  TokTokState.localUser.isHost = isCreator;

  if (isVip) {
    TokTokState.room.userCoins = 999999999;
  } else {
    if (!localStorage.getItem("toktok_user_coins")) {
      TokTokState.room.userCoins = 1000;
      localStorage.setItem("toktok_user_coins", "1000");
    }
  }

  localStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify({
    id: TokTokState.localUser.id,
    name: TokTokState.localUser.name,
    handle: TokTokState.localUser.handle,
    email: TokTokState.localUser.email,
    avatarBg: TokTokState.localUser.avatarBg,
    isHost: TokTokState.localUser.isHost,
    isCreator: TokTokState.localUser.isCreator,
    hasInfiniteCoins: TokTokState.localUser.hasInfiniteCoins
  }));
  updateProfileHeaderUI();
  updateCoinsDisplay();
  renderVideoGrid();
}

function updateProfileHeaderUI() {
  const nameEl = document.getElementById("headerProfileName");
  const modalName = document.getElementById("profileModalDisplayName");
  const modalHandle = document.getElementById("profileModalHandle");
  const modalEmail = document.getElementById("profileModalEmail");
  const modalAvatar = document.getElementById("profileModalAvatar");
  const inputName = document.getElementById("profileNameInput");
  const inputHandle = document.getElementById("profileHandleInput");
  const creatorPill = document.getElementById("headerCreatorPill");
  const roleBadge = document.getElementById("profileModalRoleBadge");

  const isCreator = TokTokState.localUser.isCreator || TokTokState.localUser.email === "davidyrosa1979@gmail.com";

  if (nameEl) {
    nameEl.textContent = isCreator ? `${TokTokState.localUser.name} (👑 Creador)` : TokTokState.localUser.name;
  }
  if (creatorPill) {
    creatorPill.style.display = isCreator ? "inline-flex" : "none";
  }
  if (roleBadge) {
    roleBadge.textContent = isCreator ? "👑 CREADOR OFICIAL" : "Anfitrión de la Sala";
    roleBadge.className = isCreator ? "badge-role-creator" : "badge-role";
  }

  if (modalName) modalName.textContent = TokTokState.localUser.name;
  if (modalHandle) modalHandle.textContent = `@${TokTokState.localUser.handle}`;
  if (modalEmail) modalEmail.textContent = "🔒 Correo Protegido y Cifrado (RGPD)";
  if (inputName) inputName.value = TokTokState.localUser.name;
  if (inputHandle) inputHandle.value = TokTokState.localUser.handle;
  if (modalAvatar) {
    modalAvatar.textContent = isCreator ? "👑" : (TokTokState.localUser.name || "TÚ").substring(0, 2).toUpperCase();
    if (isCreator) {
      modalAvatar.style.background = "linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)";
      modalAvatar.style.color = "#000";
    }
  }
}

// ===================================================================
// MOTOR DE AUDIO SINTETIZADO (Web Audio API)
// ===================================================================
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      if (audioCtx.onstatechange !== undefined) {
        audioCtx.onstatechange = () => {
          if (audioCtx && audioCtx.state === 'running') {
            const p = document.getElementById("mobileAudioPrompt");
            if (p) p.remove();
          }
        };
      }
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function unlockAudioContexts() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  const prompt = document.getElementById("mobileAudioPrompt");
  if (prompt) prompt.remove();
  const audio = document.getElementById("tokLiveRemoteAudio");
  if (audio && audio.paused && audio.srcObject) {
    audio.play().catch(() => {});
  }
}

// Desbloquear motor de audio con cualquier interacción en pantalla móvil (iOS Safari, Android)
window.addEventListener("click", unlockAudioContexts, { passive: true });
window.addEventListener("touchstart", unlockAudioContexts, { passive: true });
window.addEventListener("touchend", unlockAudioContexts, { passive: true });

function playSoundFx(type) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'heart' || type === 'pop') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(420, now);
      osc.frequency.exponentialRampToValueAtTime(840, now + 0.08);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'chime' || type === 'join') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(783.99, now + 0.1);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'fanfare' || type === 'magic' || type === 'roar') {
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.14, now + (idx * 0.08));
        g.gain.exponentialRampToValueAtTime(0.001, now + (idx * 0.08) + 0.3);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(now + (idx * 0.08));
        o.stop(now + (idx * 0.08) + 0.3);
      });
    }
  } catch (err) {
    console.warn("Audio FX no disponible:", err);
  }
}

// ===================================================================
// INICIALIZACIÓN DE LA CÁMARA LOCAL & DISPOSITIVOS
// ===================================================================
async function setupLocalCamera() {
  if (TokTokState.localUser.mediaStream && TokTokState.localUser.mediaStream.active) {
    bindLocalStreamToVideoElements();
    startLocalCameraFrameRelay();
    startLiveAudioCapture(TokTokState.localUser.mediaStream);
    return TokTokState.localUser.mediaStream;
  }

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      let stream = null;
      try {
        // Intento 1: Cámara frontal móvil con audio con cancelación de eco y supresión de ruido
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true },
            channelCount: 1
          }
        });
      } catch (err1) {
        console.warn("Reintentando cámara con constraints estándar:", err1);
        try {
          // Intento 2: Estándar video + audio optimizado
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (err2) {
          console.warn("Reintentando solo video:", err2);
          // Intento 3: Solo video si hay conflicto de audio en Safari
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
      }

      if (stream) {
        TokTokState.localUser.mediaStream = stream;
        bindLocalStreamToVideoElements();
        setupLocalAudioDetection(stream);

        // Si ya hay conexiones WebRTC activas, sincronizar las pistas
        for (const [peerId, pc] of rtcPeerConnections.entries()) {
          stream.getTracks().forEach(track => {
            const senders = pc.getSenders();
            const sender = senders.find(s => s.track && s.track.kind === track.kind);
            if (sender) {
              sender.replaceTrack(track).catch(() => {});
            } else {
              try { pc.addTrack(track, stream); } catch (_) {}
            }
          });
        }
        startLocalCameraFrameRelay();
        startLiveAudioCapture(stream);
        return stream;
      }
    }
  } catch (err) {
    console.warn("Acceso a cámara física no concedido o no disponible:", err);
  }

  const localCanvasElem = document.getElementById("localUserCanvas");
  if (localCanvasElem) renderSimulatedLocalCamera(localCanvasElem);
}

function bindLocalStreamToVideoElements() {
  const stream = TokTokState.localUser.mediaStream;
  if (!stream) return;

  // Asiento 0 (Anfitrión Local)
  if (TokTokState.localUser.isHost) {
    const localVideoElem = document.getElementById("localUserVideo");
    if (localVideoElem) {
      if (localVideoElem.srcObject !== stream) {
        localVideoElem.srcObject = stream;
      }
      localVideoElem.muted = true;
      localVideoElem.playsInline = true;
      localVideoElem.setAttribute("playsinline", "");
      localVideoElem.setAttribute("webkit-playsinline", "");
      localVideoElem.style.display = TokTokState.localUser.cameraOn ? "block" : "none";
      localVideoElem.play().catch(() => {});
    }
    const localCanvasElem = document.getElementById("localUserCanvas");
    if (localCanvasElem) localCanvasElem.style.display = "none";
  }

  // Si el usuario local está en algún asiento de invitado (asientos 1 al 15)
  for (let i = 1; i <= TokTokState.room.maxGuestSeats; i++) {
    const localGuestVid = document.getElementById(`localGuestVideo-${i}`);
    if (localGuestVid) {
      if (localGuestVid.srcObject !== stream) {
        localGuestVid.srcObject = stream;
      }
      localGuestVid.muted = true;
      localGuestVid.playsInline = true;
      localGuestVid.setAttribute("playsinline", "");
      localGuestVid.setAttribute("webkit-playsinline", "");
      localGuestVid.style.display = TokTokState.localUser.cameraOn ? "block" : "none";
      localGuestVid.play().catch(() => {});
    }
  }
}

function setupLocalAudioDetection(stream) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    TokTokState.localUser.analyser = analyser;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function checkAudio() {
      if (TokTokState.localUser.micOn && analyser) {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;
        const isSpeaking = avg > 20;
        setSlotSpeaking("seat-0", isSpeaking);
      } else {
        setSlotSpeaking("seat-0", false);
      }
      requestAnimationFrame(checkAudio);
    }
    checkAudio();
  } catch (err) {
    console.warn("No se pudo iniciar el detector de voz local:", err);
  }
}

function renderSimulatedLocalCamera(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let frame = 0;

  function drawSimulatedCamera() {
    frame++;
    const width = canvas.width = 320;
    const height = canvas.height = 200;

    const grad = ctx.createRadialGradient(width/2, height/2, 20, width/2, height/2, 160);
    grad.addColorStop(0, "#252b45");
    grad.addColorStop(1, "#121420");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    const breathe = Math.sin(frame * 0.05) * 4;
    
    ctx.fillStyle = "#333a56";
    ctx.beginPath();
    ctx.ellipse(width/2, height + 10, 80, 50 + breathe, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffb088";
    ctx.beginPath();
    ctx.arc(width/2, height/2 - 10 + (breathe * 0.5), 36, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1e1e2d";
    ctx.beginPath();
    ctx.arc(width/2, height/2 - 22 + (breathe * 0.5), 38, Math.PI, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.font = "bold 10px 'Plus Jakarta Sans', sans-serif";
    ctx.fillText("TOK TOK • ANFITRIÓN LIVE", 12, 22);

    requestAnimationFrame(drawSimulatedCamera);
  }
  drawSimulatedCamera();
}

// ===================================================================
// GESTIÓN DE SALIDA VOLUNTARIA DEL ESCENARIO
// ===================================================================
function updateDockLeaveStageVisibility() {
  const leaveBtn = document.getElementById("dockLeaveStageBtn");
  if (!leaveBtn) return;
  const isGuestOnStage = TokTokState.guestsOnStage.some(g => g && g.id === TokTokState.localUser.id);
  leaveBtn.style.display = isGuestOnStage ? "inline-flex" : "none";
}

function leaveStage() {
  if (!confirm("¿Deseas bajarte del escenario y volver a ser espectador?")) return;

  // 1. Detener pistas de cámara y micrófono local
  if (TokTokState.localUser.mediaStream) {
    try {
      TokTokState.localUser.mediaStream.getTracks().forEach(track => {
        track.stop();
      });
    } catch (_) {}
    TokTokState.localUser.mediaStream = null;
  }
  TokTokState.localUser.cameraOn = false;
  TokTokState.localUser.micOn = false;

  // Detener procesador de audio en vivo si estaba corriendo
  if (liveAudioProcessor) {
    try { liveAudioProcessor.disconnect(); } catch (_) {}
    liveAudioProcessor = null;
  }
  if (liveAudioSource) {
    try { liveAudioSource.disconnect(); } catch (_) {}
    liveAudioSource = null;
  }

  // 2. Notificar al servidor vía POST y WebSocket
  const leavePayload = {
    userId: TokTokState.localUser.id,
    handle: TokTokState.localUser.handle,
    name: TokTokState.localUser.name
  };

  fetch("/api/stage/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(leavePayload)
  }).then(res => res.json()).then(data => {
    if (data && data.stageSeats) {
      syncStageSeats(data.stageSeats);
    }
  }).catch(() => {});

  if (realtimeSocket && realtimeSocket.readyState === 1) {
    try {
      realtimeSocket.send(JSON.stringify({ type: "stage_leave", data: leavePayload }));
    } catch (_) {}
  }

  // 3. Remover localmente del escenario
  TokTokState.guestsOnStage = TokTokState.guestsOnStage.filter(g => g && g.id !== TokTokState.localUser.id);
  renderVideoGrid();
  updateDockLeaveStageVisibility();
  playSoundFx('pop');
  alert("Te has bajado del escenario con éxito. Ahora continúas en la sala como espectador.");
}
window.leaveStage = leaveStage;

// ===================================================================
// RENDERIZADO DEL ESCENARIO (1 HOST + HASTA 15 ASIENTOS DE INVITADOS)
// NO DESTRUYE ELEMENTOS <video> ACTIVOS PARA EVITAR QUE SE CONGELE LA CÁMARA
// ===================================================================
function renderVideoGrid() {
  const gridContainer = document.getElementById("videoGrid");
  if (!gridContainer) return;

  // 1. Asiento 0: Anfitrión (DYR)
  let hostSlot = document.getElementById("seat-0");
  if (!hostSlot) {
    hostSlot = createHostSeatElement();
    gridContainer.appendChild(hostSlot);
  } else {
    updateHostSeatElement(hostSlot);
  }

  // 2. Asientos 1 al 15: Invitados según su posición exacta en stageSeats
  for (let i = 1; i <= TokTokState.room.maxGuestSeats; i++) {
    let guestData = null;
    if (TokTokState.stageSeats && TokTokState.stageSeats[i]) {
      guestData = TokTokState.stageSeats[i];
    } else if (TokTokState.guestsOnStage) {
      guestData = TokTokState.guestsOnStage.find(g => g && g.seatIndex === i);
    }

    let seatSlot = document.getElementById(`seat-${i}`);
    const isMovingActive = TokTokState.movingFromSeatIndex !== null;

    if (guestData) {
      const currentGuestId = seatSlot ? seatSlot.dataset.guestId : null;
      if (!seatSlot || seatSlot.classList.contains("empty-seat-slot") || currentGuestId !== guestData.id || seatSlot.dataset.movingMode !== String(isMovingActive)) {
        const newOccupiedSlot = createOccupiedSeatElement(guestData, i);
        if (seatSlot) {
          gridContainer.replaceChild(newOccupiedSlot, seatSlot);
        } else {
          gridContainer.appendChild(newOccupiedSlot);
        }
      } else {
        updateOccupiedSeatElement(seatSlot, guestData, i);
      }
    } else {
      if (!seatSlot || !seatSlot.classList.contains("empty-seat-slot") || seatSlot.dataset.movingMode !== String(isMovingActive)) {
        const emptySlot = createEmptySeatElement(i);
        if (seatSlot) {
          gridContainer.replaceChild(emptySlot, seatSlot);
        } else {
          gridContainer.appendChild(emptySlot);
        }
      }
    }
  }

  bindLocalStreamToVideoElements();
  updateStageStatsUI();
  renderStageGuestsListTab();
  updateDockLeaveStageVisibility();
}

function createHostSeatElement() {
  const slot = document.createElement("div");
  const isCreator = TokTokState.localUser.isCreator || TokTokState.localUser.email === "davidyrosa1979@gmail.com";
  slot.className = `guest-slot is-host ${isCreator ? 'is-creator' : ''}`;
  slot.id = "seat-0";

  if (TokTokState.localUser.isHost) {
    // Si el usuario local es el Anfitrión, mostrar su cámara local
    slot.innerHTML = `
      <video id="localUserVideo" class="video-media-element" autoplay playsinline muted style="display:none; width: 100%; height: 100%; object-fit: cover;"></video>
      <canvas id="localUserCanvas" class="video-media-element" width="320" height="200" style="display:none;"></canvas>
      <div class="video-off-placeholder" id="localVideoOffHolder" style="display: ${TokTokState.localUser.cameraOn ? 'none' : 'flex'};">
        <div class="avatar-disc" style="${isCreator ? 'background: linear-gradient(135deg, #ffd700, #ff8c00); box-shadow: 0 0 20px rgba(255, 215, 0, 0.5);' : ''}">
          <div class="avatar-inner-img" style="${isCreator ? 'color: #000; font-weight: 900;' : ''}">${isCreator ? '👑' : 'TÚ'}</div>
        </div>
        <span style="font-size: 11px; color: ${isCreator ? '#ffd700' : 'var(--text-muted)'}; font-weight: 700;">${isCreator ? '👑 CREADOR OFICIAL' : 'Cámara Apagada'}</span>
      </div>
      <div class="slot-badge-bar">
        <span class="slot-name-tag">
          <span class="${isCreator ? 'creator-badge-chip' : 'host-badge-chip'}">${isCreator ? '👑 CREADOR' : 'ANFITRIÓN'}</span>
          <strong style="${isCreator ? 'color: #ffd700;' : ''}">${TokTokState.localUser.name}</strong>
        </span>
        <div class="slot-status-icons">
          <div class="mic-badge ${TokTokState.localUser.micOn ? '' : 'muted'}" id="localMicBadgeIcon">
            ${TokTokState.localUser.micOn ? '🎙️' : '🔇'}
          </div>
        </div>
      </div>
    `;
  } else {
    // Si el usuario local es un Invitado (Rosa), en el asiento 0 ve la cámara del Host (DYR)
    slot.innerHTML = `
      <video id="hostRemoteVideo" class="video-media-element" autoplay playsinline style="display:block; width: 100%; height: 100%; object-fit: cover;"></video>
      <div class="video-off-placeholder" id="localVideoOffHolder" style="display: none;">
        <div class="avatar-disc" style="background: linear-gradient(135deg, #ffd700, #ff8c00); box-shadow: 0 0 20px rgba(255, 215, 0, 0.5);">
          <div class="avatar-inner-img" style="color: #000; font-weight: 900;">👑</div>
        </div>
        <span style="font-size: 11px; color: #ffd700; font-weight: 700;">👑 CREADOR DYR</span>
      </div>
      <div class="slot-badge-bar">
        <span class="slot-name-tag">
          <span class="creator-badge-chip">👑 CREADOR</span>
          <strong style="color: #ffd700;">DYR</strong>
        </span>
        <div class="slot-status-icons">
          <div class="mic-badge" id="hostMicBadgeIcon">🎙️</div>
        </div>
      </div>
    `;
  }

  slot.addEventListener("click", (e) => {
    burstHearts(e.clientX, e.clientY);
  });

  return slot;
}

function updateHostSeatElement(slot) {
  const isCreator = TokTokState.localUser.isCreator || TokTokState.localUser.email === "davidyrosa1979@gmail.com";
  const micBadge = document.getElementById("localMicBadgeIcon");
  if (micBadge) {
    micBadge.className = `mic-badge ${TokTokState.localUser.micOn ? '' : 'muted'}`;
    micBadge.textContent = TokTokState.localUser.micOn ? '🎙️' : '🔇';
  }
  const offHolder = document.getElementById("localVideoOffHolder");
  if (offHolder && TokTokState.localUser.isHost) {
    offHolder.style.display = TokTokState.localUser.cameraOn ? 'none' : 'flex';
  }
}

function createOccupiedSeatElement(guest, seatIndex) {
  const slot = document.createElement("div");
  slot.className = "guest-slot";
  slot.id = `seat-${seatIndex}`;
  slot.dataset.guestId = guest.id;
  slot.dataset.movingMode = String(TokTokState.movingFromSeatIndex !== null);
  const initial = (guest.name || "US").substring(0, 2).toUpperCase();
  const isMod = isUserModerator(guest.id) || isUserModerator(guest.handle) || isUserModerator(guest.name);
  const isMe = guest.id === TokTokState.localUser.id;
  const isHostUser = TokTokState.localUser.isHost || TokTokState.localUser.id === "user_dyr_creator";

  if (isMe) {
    // Es el propio usuario local en el asiento del escenario
    slot.innerHTML = `
      <video class="video-media-element" id="localGuestVideo-${seatIndex}" autoplay playsinline muted style="display: ${TokTokState.localUser.cameraOn ? 'block' : 'none'}; width: 100%; height: 100%; object-fit: cover;"></video>
      <div class="video-off-placeholder" id="guestVideoOff-${seatIndex}" style="display: ${TokTokState.localUser.cameraOn ? 'none' : 'flex'};">
        <div class="avatar-disc" style="background: ${guest.avatarBg}">
          <div class="avatar-inner-img">${initial}</div>
        </div>
        <span style="font-size: 11px; color: var(--text-muted);">Cámara Apagada</span>
      </div>
      <!-- Botón para Bajarse del Escenario -->
      <button class="btn-slot-leave-stage" onclick="event.stopPropagation(); leaveStage();" title="Bajarse del escenario y volver a ser espectador" style="position: absolute; top: 6px; right: 6px; z-index: 10; background: rgba(254, 44, 85, 0.92); color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 6px; padding: 4px 8px; font-size: 11px; font-weight: 800; cursor: pointer; display: flex; align-items: center; gap: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.5);">
        🚪 Bajar
      </button>
      <div class="slot-badge-bar">
        <span class="slot-name-tag">
          <span style="color: var(--tok-cyan);">● TÚ (#${seatIndex + 1})</span>
          <strong>${guest.name}</strong>
        </span>
        <div class="slot-status-icons">
          <div class="mic-badge ${TokTokState.localUser.micOn ? '' : 'muted'}" id="micBadge-${seatIndex}">
            ${TokTokState.localUser.micOn ? '🎙️' : '🔇'}
          </div>
        </div>
      </div>
    `;
  } else {
    // Es otro usuario remoto conectado en vivo (Rosa, Pikachu, etc.)
    slot.innerHTML = `
      <video class="video-media-element guest-video-player" id="video-guest-${seatIndex}" autoplay playsinline style="display: block; width: 100%; height: 100%; object-fit: cover;"></video>
      <div class="video-off-placeholder" id="guestVideoOff-${seatIndex}" style="display: none;">
        <div class="avatar-disc" style="background: ${guest.avatarBg}">
          <div class="avatar-inner-img">${initial}</div>
        </div>
        <span style="font-size: 11px; color: var(--text-muted);">Cámara Apagada</span>
      </div>
      <div class="slot-badge-bar">
        <span class="slot-name-tag interactive-stage-user" style="cursor: pointer;" title="Haz clic para enviar regalo o interactuar con ${guest.name}">
          ${isMod ? '<span class="chat-badge-mod" style="font-size: 8px;">🛡️ MOD</span>' : '<span style="color: var(--tok-cyan);">● #' + (seatIndex + 1) + '</span>'}
          <span>${guest.name}</span>
          <span style="font-size: 11px; margin-left: 2px;" title="Mandar regalo">🎁</span>
        </span>
        <div class="slot-status-icons">
          <div class="mic-badge ${guest.micOn ? '' : 'muted'}" id="micBadge-${seatIndex}">
            ${guest.micOn ? '🎙️' : '🔇'}
          </div>
        </div>
      </div>
    `;

    const nameTag = slot.querySelector(".interactive-stage-user");
    if (nameTag) {
      nameTag.addEventListener("click", (e) => {
        e.stopPropagation();
        openChatUserContextMenu(guest.name, guest.handle || `@${guest.name.toLowerCase()}`, "", e);
      });
    }

    const existingStream = remoteStreams.get(guest.id);
    if (existingStream) {
      setTimeout(() => {
        const vid = document.getElementById(`video-guest-${seatIndex}`);
        if (vid) {
          vid.srcObject = existingStream;
          vid.playsInline = true;
          vid.setAttribute("playsinline", "");
          vid.setAttribute("webkit-playsinline", "");
          vid.play().catch(() => {});
        }
      }, 50);
    }
  }

  // Controles exclusivos del Anfitrión para mover y reordenar asientos
  if (isHostUser) {
    slot.setAttribute("draggable", "true");

    const isThisSource = TokTokState.movingFromSeatIndex === seatIndex;
    const moveBtn = document.createElement("button");
    moveBtn.className = "btn-move-seat-chip";
    moveBtn.innerHTML = isThisSource ? "✕ Cancelar" : "🔀 Mover";
    moveBtn.title = isThisSource ? "Cancelar movimiento" : "Mover este asiento a otra posición";
    moveBtn.onclick = (e) => {
      e.stopPropagation();
      startMovingSeat(seatIndex);
    };
    slot.appendChild(moveBtn);

    if (isThisSource) {
      slot.classList.add("is-moving-source");
    } else if (TokTokState.movingFromSeatIndex !== null) {
      slot.classList.add("is-moving-target");
      const banner = document.createElement("div");
      banner.className = "seat-move-target-banner";
      banner.innerHTML = `
        <span>🔄 Cambiar aquí</span>
        <span style="font-size: 10px; opacity: 0.85;">Asiento #${seatIndex + 1} (${guest.name})</span>
      `;
      banner.onclick = (e) => {
        e.stopPropagation();
        executeSeatSwap(TokTokState.movingFromSeatIndex, seatIndex);
      };
      slot.appendChild(banner);
    }

    slot.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", seatIndex.toString());
      TokTokState.movingFromSeatIndex = seatIndex;
    });
    slot.addEventListener("dragover", (e) => { e.preventDefault(); });
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (from && from !== seatIndex) {
        executeSeatSwap(from, seatIndex);
      }
    });
  }

  slot.addEventListener("click", (e) => {
    burstHearts(e.clientX, e.clientY);
    if (!isMe && !isHostUser) {
      openGiftDrawerForUser(guest);
    }
  });

  return slot;
}

function updateOccupiedSeatElement(slot, guest, seatIndex) {
  slot.dataset.guestId = guest.id;
  const isMe = guest.id === TokTokState.localUser.id;
  const micBadge = document.getElementById(`micBadge-${seatIndex}`);
  if (micBadge) {
    const isMicOn = isMe ? TokTokState.localUser.micOn : guest.micOn;
    micBadge.className = `mic-badge ${isMicOn ? '' : 'muted'}`;
    micBadge.textContent = isMicOn ? '🎙️' : '🔇';
  }
}

function createEmptySeatElement(seatIndex) {
  const slot = document.createElement("div");
  slot.className = "guest-slot empty-seat-slot";
  slot.id = `seat-${seatIndex}`;
  slot.dataset.movingMode = String(TokTokState.movingFromSeatIndex !== null);
  delete slot.dataset.guestId;
  const isHostUser = TokTokState.localUser.isHost || TokTokState.localUser.id === "user_dyr_creator";

  slot.innerHTML = `
    <span class="seat-number-label">Asiento #${seatIndex + 1} de 16</span>
    <div class="seat-empty-inner">
      <div class="seat-plus-circle">➕</div>
      <span class="seat-empty-title">Invitar Usuario</span>
      <span style="font-size: 10px; color: var(--text-muted);">Asiento Disponible</span>
    </div>
  `;

  if (isHostUser) {
    if (TokTokState.movingFromSeatIndex !== null) {
      slot.classList.add("is-moving-target");
      const banner = document.createElement("div");
      banner.className = "seat-move-target-banner";
      banner.innerHTML = `
        <span>📍 Mover a este Asiento</span>
        <span style="font-size: 10px; opacity: 0.85;">Asiento #${seatIndex + 1} Libre</span>
      `;
      banner.onclick = (e) => {
        e.stopPropagation();
        executeSeatSwap(TokTokState.movingFromSeatIndex, seatIndex);
      };
      slot.appendChild(banner);
    }

    slot.addEventListener("dragover", (e) => { e.preventDefault(); });
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (from && from !== seatIndex) {
        executeSeatSwap(from, seatIndex);
      }
    });
  }

  slot.addEventListener("click", () => {
    if (TokTokState.movingFromSeatIndex === null) {
      openModal("inviteModal");
    }
  });

  return slot;
}

function startMovingSeat(seatIndex) {
  if (!TokTokState.localUser.isHost && TokTokState.localUser.id !== "user_dyr_creator") return;
  if (TokTokState.movingFromSeatIndex === seatIndex) {
    TokTokState.movingFromSeatIndex = null;
  } else {
    TokTokState.movingFromSeatIndex = seatIndex;
    playSoundFx('pop');
  }
  renderVideoGrid();
}
window.startMovingSeat = startMovingSeat;

function executeSeatSwap(fromIndex, toIndex) {
  if (!TokTokState.localUser.isHost && TokTokState.localUser.id !== "user_dyr_creator") return;
  fromIndex = parseInt(fromIndex, 10);
  toIndex = parseInt(toIndex, 10);
  if (!fromIndex || !toIndex || fromIndex === toIndex) return;

  TokTokState.movingFromSeatIndex = null;

  // Actualización optimista inmediata en cliente
  if (TokTokState.stageSeats) {
    const temp = TokTokState.stageSeats[fromIndex];
    TokTokState.stageSeats[fromIndex] = TokTokState.stageSeats[toIndex];
    TokTokState.stageSeats[toIndex] = temp;
    if (TokTokState.stageSeats[fromIndex]) TokTokState.stageSeats[fromIndex].seatIndex = fromIndex;
    if (TokTokState.stageSeats[toIndex]) TokTokState.stageSeats[toIndex].seatIndex = toIndex;
  }

  renderVideoGrid();
  playSoundFx('fanfare');

  const swapPayload = {
    fromIndex,
    toIndex,
    hostUserId: TokTokState.localUser.id
  };

  if (realtimeSocket && realtimeSocket.readyState === 1) {
    try {
      realtimeSocket.send(JSON.stringify({ type: "stage_swap", data: swapPayload }));
    } catch (_) {}
  }

  fetch("/api/stage/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapPayload)
  }).then(res => res.json()).then(data => {
    if (data && data.stageSeats) {
      syncStageSeats(data.stageSeats);
    }
  }).catch(() => {});
}
window.executeSeatSwap = executeSeatSwap;

// Stream visual activo de los usuarios registrados que suben al escenario
function startGuestProceduralStream(canvasId, hue, guestName) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let frame = Math.floor(Math.random() * 500);

  function renderGuestFrame() {
    frame++;
    const width = canvas.width;
    const height = canvas.height;

    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, `hsl(${hue}, 40%, 14%)`);
    bgGrad.addColorStop(1, `hsl(${(hue + 40) % 360}, 50%, 8%)`);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.shadowBlur = 24;
    ctx.shadowColor = `hsl(${hue}, 80%, 50%)`;
    ctx.strokeStyle = `hsl(${hue}, 80%, 60%)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, 18);
    ctx.lineTo(width - 10, 18);
    ctx.stroke();
    ctx.restore();

    const bob = Math.sin(frame * 0.04) * 3;
    const tilt = Math.cos(frame * 0.03) * 0.02;

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(tilt);

    ctx.fillStyle = `hsl(${hue}, 20%, 25%)`;
    ctx.beginPath();
    ctx.ellipse(0, 70 + bob, 75, 45, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f3b391";
    ctx.beginPath();
    ctx.arc(0, -5 + bob, 34, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 25%, 15%)`;
    ctx.beginPath();
    ctx.arc(0, -14 + bob, 36, Math.PI * 0.9, Math.PI * 2.1);
    ctx.fill();

    const isBlinking = (frame % 120 < 6);
    ctx.fillStyle = "#222";
    if (!isBlinking) {
      ctx.beginPath();
      ctx.arc(-11, -6 + bob, 3, 0, Math.PI * 2);
      ctx.arc(11, -6 + bob, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-14, -6 + bob);
      ctx.lineTo(-8, -6 + bob);
      ctx.moveTo(8, -6 + bob);
      ctx.lineTo(14, -6 + bob);
      ctx.stroke();
    }

    ctx.restore();

    requestAnimationFrame(renderGuestFrame);
  }

  renderGuestFrame();
}

function setSlotSpeaking(slotId, isSpeaking) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  if (isSpeaking) {
    slot.classList.add("is-speaking");
  } else {
    slot.classList.remove("is-speaking");
  }
}

function startGuestAudioSimulation() {
  // Desactivado: Solo usuarios reales que transmiten audio
}

// ===================================================================
// INVITAR Y GESTIONAR USUARIOS REGISTRADOS EN EL ESCENARIO
// ===================================================================
function inviteRegisteredUser(userId) {
  if (TokTokState.guestsOnStage.length >= TokTokState.room.maxGuestSeats) {
    alert("¡La sala ha alcanzado su capacidad máxima de 15 invitados en cámara! Libera un asiento para invitar a otro usuario.");
    return;
  }

  const user = TokTokState.registeredUsers.find(u => u.id === userId);
  if (!user) return;

  const isAlreadyOnStage = TokTokState.guestsOnStage.some(g => g.id === userId);
  if (isAlreadyOnStage) {
    alert(`${user.name} (${user.handle}) ya está participando en el escenario.`);
    return;
  }

  // Notificar al servidor en tiempo real con ID, handle y nombre para coincidencia 100% garantizada
  fetch("/api/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetUserId: user.id,
      targetHandle: user.handle,
      targetName: user.name,
      fromUser: {
        id: TokTokState.localUser.id,
        name: TokTokState.localUser.name,
        handle: TokTokState.localUser.handle
      }
    })
  }).then(res => res.json()).then(() => {
    playSoundFx("pop");
    addChatMessage("TokTokBot", `📢 Has enviado una invitación al escenario a ${user.name} (${user.handle}).`);
    alert(`📨 Invitación enviada en vivo a ${user.name}.\nEn cuanto pulse "Aceptar" en su teléfono, se encenderá su cámara y subirá al escenario.`);
  }).catch(() => {});
}

function removeGuestFromStage(identifier) {
  if (!identifier) return;
  const target = String(identifier).toLowerCase().replace('@', '').trim();

  const index = TokTokState.guestsOnStage.findIndex(g => 
    (g.id && g.id.toLowerCase() === target) ||
    (g.name && g.name.toLowerCase() === target) ||
    (g.handle && g.handle.toLowerCase().replace('@', '') === target)
  );

  let removedId = identifier;
  if (index !== -1) {
    const removed = TokTokState.guestsOnStage.splice(index, 1)[0];
    removedId = removed.id;
    addChatMessage("TokTokBot", `👋 ${removed.name || removed.handle} ha bajado del escenario.`);
  }

  fetch("/api/stage/kick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: removedId })
  }).catch(() => {});

  renderVideoGrid();
  renderRegisteredUsersDirectory();
  renderStageGuestsListTab();
  renderHostControlModal();
  updateStageCapacityBadges();
}

// ===================================================================
// FUNCIONES DEL MENÚ DE CONTROL Y MODERACIÓN DEL ANFITRIÓN
// ===================================================================
function hostMuteAllGuests() {
  TokTokState.guestsOnStage.forEach(g => g.micOn = false);
  renderVideoGrid();
  renderHostControlModal();
  addChatMessage("🛡️ Moderación", "🔇 El anfitrión ha silenciado los micrófonos de todos los invitados.");
}

function hostDisableAllCams() {
  TokTokState.guestsOnStage.forEach(g => g.cameraOn = false);
  renderVideoGrid();
  renderHostControlModal();
  addChatMessage("🛡️ Moderación", "📷 El anfitrión ha apagado las cámaras de todos los invitados.");
}

function hostToggleLockRoom() {
  TokTokState.moderation.isRoomLocked = !TokTokState.moderation.isRoomLocked;
  const isLocked = TokTokState.moderation.isRoomLocked;
  const icon = document.getElementById("lockRoomIcon");
  const label = document.getElementById("lockRoomLabel");
  const btn = document.getElementById("hostToggleLockRoomBtn");

  if (icon) icon.textContent = isLocked ? "🔒" : "🔓";
  if (label) label.textContent = isLocked ? "Desbloquear Sala (Pública)" : "Bloquear Sala (Privada)";
  if (btn) btn.classList.toggle("active-warning", isLocked);

  addChatMessage("🛡️ Moderación", isLocked ? "🔒 El anfitrión ha BLOQUEADO la sala (no se admiten nuevas peticiones)." : "🔓 La sala vuelve a estar ABIERTA a peticiones de invitados.");
}

function hostToggleChat() {
  TokTokState.moderation.isChatMuted = !TokTokState.moderation.isChatMuted;
  const isMuted = TokTokState.moderation.isChatMuted;
  const icon = document.getElementById("chatModIcon");
  const label = document.getElementById("chatModLabel");
  const btn = document.getElementById("hostToggleChatBtn");

  if (icon) icon.textContent = isMuted ? "🔇" : "💬";
  if (label) label.textContent = isMuted ? "Reanudar Chat en Vivo" : "Pausar Chat en Vivo";
  if (btn) btn.classList.toggle("active-warning", isMuted);

  addChatMessage("🛡️ Moderación", isMuted ? "🔇 El anfitrión ha pausado temporalmente los comentarios del chat." : "💬 El chat en vivo ha sido reanudado.");
}

function hostToggleGuestMic(userId) {
  const guest = TokTokState.guestsOnStage.find(g => g.id === userId);
  if (guest) {
    guest.micOn = !guest.micOn;
    renderVideoGrid();
    renderHostControlModal();
    addChatMessage("🛡️ Moderación", `${guest.handle} fue ${guest.micOn ? 'activado' : 'silenciado'} por el anfitrión.`);
  }
}

function hostToggleGuestCam(userId) {
  const guest = TokTokState.guestsOnStage.find(g => g.id === userId);
  if (guest) {
    guest.cameraOn = !guest.cameraOn;
    renderVideoGrid();
    renderHostControlModal();
    addChatMessage("🛡️ Moderación", `La cámara de ${guest.handle} fue ${guest.cameraOn ? 'encendida' : 'apagada'} por el anfitrión.`);
  }
}

function hostKickGuest(userId) {
  const guest = TokTokState.guestsOnStage.find(g => g.id === userId);
  if (guest) {
    removeGuestFromStage(userId);
    renderHostControlModal();
    addChatMessage("🛡️ Moderación", `👢 ${guest.handle} fue expulsado del escenario por el anfitrión.`);
  }
}

function hostBanGuest(userId) {
  const user = TokTokState.registeredUsers.find(u => u.id === userId) || TokTokState.guestsOnStage.find(g => g.id === userId);
  if (!user) return;

  if (!confirm(`¿Estás seguro de que deseas banear y bloquear a ${user.name} (${user.handle}) de la sala?`)) {
    return;
  }
  banUser(user);
}

function hostUnbanUser(userId) {
  unbanUser(userId);
}

function renderHostControlModal() {
  const guestListEl = document.getElementById("hostControlGuestsList");
  const bannedListEl = document.getElementById("bannedUsersList");
  const guestCountEl = document.getElementById("modGuestCount");
  const bannedCountEl = document.getElementById("modBannedCount");

  if (guestCountEl) guestCountEl.textContent = TokTokState.guestsOnStage.length;
  if (bannedCountEl) bannedCountEl.textContent = TokTokState.moderation.bannedUserIds.length;
  renderModeratorsList();

  if (guestListEl) {
    guestListEl.innerHTML = "";
    if (TokTokState.guestsOnStage.length === 0) {
      guestListEl.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 11.5px; padding: 12px;">No hay invitados en el escenario actualmente.</div>`;
    } else {
      TokTokState.guestsOnStage.forEach((guest, idx) => {
        const item = document.createElement("div");
        item.className = "mod-guest-card";
        item.innerHTML = `
          <div class="mod-guest-info">
            <div class="mod-guest-avatar" style="background: ${guest.avatarBg}">
              ${guest.name.substring(0, 2).toUpperCase()}
            </div>
            <div class="mod-guest-details">
              <span class="mod-guest-name">${guest.name} (${guest.handle})</span>
              <span class="mod-guest-seat">Asiento #${idx + 2} de 16</span>
            </div>
          </div>
          <div class="mod-guest-controls">
            <button class="btn-mod-tool" onclick="hostToggleGuestMic('${guest.id}')" title="Silenciar / Activar Mic">${guest.micOn ? '🎙️ Mute' : '🔇 Unmute'}</button>
            <button class="btn-mod-tool" onclick="hostToggleGuestCam('${guest.id}')" title="Apagar / Encender Cámara">${guest.cameraOn ? '📷 Cam ON' : '🚫 Cam OFF'}</button>
            <button class="btn-mod-tool btn-danger-tool" onclick="hostKickGuest('${guest.id}')" title="Bajar del escenario">👢 Echar</button>
            <button class="btn-mod-tool btn-danger-tool" onclick="hostBanGuest('${guest.id}')" title="Bloquear y banear de la sala">🚫 Banear</button>
          </div>
        `;
        guestListEl.appendChild(item);
      });
    }
  }

  if (bannedListEl) {
    bannedListEl.innerHTML = "";
    if (TokTokState.moderation.bannedUserIds.length === 0) {
      bannedListEl.innerHTML = `<div style="color: var(--text-muted); font-size: 11px; padding: 6px;">No hay usuarios baneados en esta sala.</div>`;
    } else {
      TokTokState.moderation.bannedUserIds.forEach(id => {
        const user = TokTokState.registeredUsers.find(u => u.id === id);
        const item = document.createElement("div");
        item.className = "banned-user-item";
        item.innerHTML = `
          <span>🚫 <strong>${user ? user.handle : id}</strong></span>
          <button class="btn-unban" onclick="hostUnbanUser('${id}')">Desbloquear</button>
        `;
        bannedListEl.appendChild(item);
      });
    }
  }

  // Renderizar lista de usuarios registrados para expulsión/eliminación definitiva
  const regListEl = document.getElementById("hostControlRegisteredUsersList");
  if (regListEl) {
    regListEl.innerHTML = "";
    const usersToDelete = TokTokState.registeredUsers.filter(u => !u.isCreator && u.id !== "user_dyr_creator" && u.handle !== "dyr" && u.name !== "DYR");
    if (usersToDelete.length === 0) {
      regListEl.innerHTML = `<div style="color: var(--text-muted); font-size: 11px; padding: 6px;">No hay otros usuarios registrados actualmente.</div>`;
    } else {
      usersToDelete.forEach(u => {
        const cleanHandle = String(u.handle || 'usuario').replace(/^@/, '');
        const safeHandle = cleanHandle.includes('@') ? cleanHandle.split('@')[0] : cleanHandle;
        const rawName = String(u.name || 'Usuario');
        const safeName = rawName.includes('@') ? rawName.split('@')[0] : rawName;

        const item = document.createElement("div");
        item.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.04); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); gap: 10px;";
        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: ${u.avatarBg || '#fe2c55'}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px; color: #fff; flex-shrink: 0;">
              ${safeName.substring(0, 2).toUpperCase()}
            </div>
            <div style="min-width: 0;">
              <strong style="font-size: 12px; color: #fff; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeName} (@${safeHandle})</strong>
              <span style="font-size: 10px; color: var(--text-muted);"><span style="color: ${u.status === 'online' ? '#00e676' : 'var(--text-muted)'}; font-weight: 600;">${u.status === 'online' ? '🟢 Conectado' : '⚪ Desconectado'}</span> • Rol: ${u.role === 'vip' ? '🌟 VIP' : 'Miembro'} • <span style="color: #25f4ee; font-weight: 700;">🔒 RGPD</span></span>
            </div>
          </div>
          <button type="button" style="background: #fe2c55; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; flex-shrink: 0;" onclick="hostPermanentlyDeleteUser('${u.id}', '${safeHandle}', '${safeName}')">
            🗑️ Expulsar y Eliminar
          </button>
        `;
        regListEl.appendChild(item);
      });
    }
  }

  // Cargar lista de cuentas expulsadas para permitir su desbloqueo inmediato
  renderExpelledUsersList();
}

function hostPermanentlyDeleteUser(userId, handle, name) {
  if (!confirm(`⚠️ ATENCIÓN: ¿Seguro que deseas EXPULSAR y ELIMINAR permanentemente a ${name} (${handle}) de la aplicación?\n\nSu sesión en el móvil se cerrará de inmediato y quedará completamente bloqueado para siempre.`)) {
    return;
  }

  fetch("/api/user/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, handle, name })
  })
  .then(res => res.json())
  .then(() => {
    // Quitar de lista local
    TokTokState.registeredUsers = TokTokState.registeredUsers.filter(u => u.id !== userId);
    saveRegisteredUsers();
    renderRegisteredUsersDirectory();
    renderHostControlModal();
    playSoundFx("pop");
    alert(`🚫 ${name} ha sido expulsado y eliminado permanentemente de la aplicación.`);
  })
  .catch(err => {
    console.error("Error eliminando usuario:", err);
  });
}

// Desbloquear cuenta y restaurar acceso por correo o nombre de usuario
async function unbanUserByEmail(emailOrHandle) {
  if (!emailOrHandle || !emailOrHandle.trim()) {
    alert("⚠️ Por favor escribe el correo electrónico o el usuario a desbloquear.");
    return;
  }
  const clean = emailOrHandle.trim();
  const isEmail = clean.includes("@") && clean.includes(".");
  const payload = isEmail ? { email: clean } : { handle: clean };

  try {
    const res = await fetch("/api/user/unban-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      playSoundFx("fanfare");
      alert(`✅ ¡CUENTA DESBLOQUEADA CON ÉXITO!\n\n${data.message || 'El usuario ha sido desbloqueado y su cuenta restaurada.'}\n\nEl usuario ya puede volver a entrar e iniciar sesión con su correo electrónico.`);
      renderExpelledUsersList();
      renderHostControlModal();
    } else {
      alert(`❌ Error al desbloquear: ${data.error || "No se pudo desbloquear"}`);
    }
  } catch (err) {
    console.error("Error al desbloquear:", err);
    alert("❌ Error de conexión al intentar desbloquear la cuenta.");
  }
}

// Renderizar la lista de usuarios expulsados con botón 1-click para desbloquear
async function renderExpelledUsersList() {
  const container = document.getElementById("expelledUsersListContainer");
  if (!container) return;

  try {
    const res = await fetch("/api/user/expelled");
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.expelled) || data.expelled.length === 0) {
      container.innerHTML = `<div style="color: var(--text-muted); font-size: 11px; padding: 6px; text-align: center;">No hay cuentas expulsadas pendientes de desbloquear.</div>`;
      return;
    }

    container.innerHTML = `<span style="font-size: 11px; color: #cbd5e1; font-weight: 700; margin-bottom: 4px; display: block;">Cuentas expulsadas recientemente:</span>`;
    data.expelled.forEach(u => {
      const item = document.createElement("div");
      item.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(254,44,85,0.3); gap: 8px;";
      item.innerHTML = `
        <div style="min-width: 0; display: flex; flex-direction: column;">
          <strong style="color: #fff; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${u.name || u.handle || 'Usuario'} ${u.handle ? `(${u.handle})` : ''}</strong>
          <span style="color: #fe2c55; font-size: 10px; font-weight: 600;">Cuenta Bloqueada</span>
        </div>
        <button type="button" style="background: #00e676; color: #000; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 800; font-size: 11px; cursor: pointer; flex-shrink: 0;" onclick="unbanUserByEmail('${u.handle || u.id}')">
          🟢 Desbloquear
        </button>
      `;
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = `<div style="color: var(--text-muted); font-size: 11px;">Error al cargar lista de expulsados.</div>`;
  }
}

function updateStageStatsUI() {
  const guestCount = TokTokState.guestsOnStage.length;
  const totalInRoom = 1 + guestCount; // Host + Guests

  const badge = document.getElementById("guestCounterBadge");
  const tabBadge = document.getElementById("guestCountTab");
  const modalText = document.getElementById("modalCapacityText");
  const modalBar = document.getElementById("modalCapacityBar");
  const dockSeatCount = document.getElementById("dockSeatCount");
  const stageCapBar = document.getElementById("stageCapacityBar");
  const inviteBtnLabel = document.getElementById("inviteBtnLabel");

  if (badge) badge.textContent = `${guestCount}/15 invitados (${totalInRoom} en cámara)`;
  if (tabBadge) tabBadge.textContent = `${guestCount}`;
  if (modalText) modalText.textContent = `${guestCount} de 15 invitados ocupados (${15 - guestCount} libres)`;
  if (modalBar) modalBar.style.width = `${(guestCount / 15) * 100}%`;
  if (dockSeatCount) dockSeatCount.textContent = `${guestCount}`;
  if (stageCapBar) stageCapBar.style.width = `${(totalInRoom / 16) * 100}%`;
  if (inviteBtnLabel) inviteBtnLabel.textContent = `Invitar Registrados (${guestCount}/15)`;
}

// ===================================================================
// RENDERIZADO DEL DIRECTORIO DE USUARIOS REGISTRADOS
// ===================================================================
function renderRegisteredUsersDirectory(filterQuery = "", onlyOnline = false) {
  const container = document.getElementById("registeredUsersListContainer");
  const totalBadge = document.getElementById("registeredUsersCount");
  if (!container) return;
  container.innerHTML = "";

  let list = TokTokState.registeredUsers;

  if (filterQuery) {
    const q = filterQuery.toLowerCase();
    list = list.filter(u => u.name.toLowerCase().includes(q) || u.handle.toLowerCase().includes(q));
  }

  if (onlyOnline) {
    list = list.filter(u => u.status === "online");
  }

  if (totalBadge) totalBadge.textContent = TokTokState.registeredUsers.length;

  if (list.length === 0) {
    container.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">
        No se encontraron usuarios registrados con ese criterio. <br/>
        ¡Usa la pestaña <strong>"➕ Registrar Nuevo Usuario"</strong> para añadir a tus amigos!
      </div>
    `;
    return;
  }

  list.forEach(user => {
    const isStageGuest = TokTokState.guestsOnStage.some(g => g.id === user.id);
    const seatNumber = isStageGuest ? TokTokState.guestsOnStage.findIndex(g => g.id === user.id) + 2 : null;

    const card = document.createElement("div");
    card.className = "user-dir-card";

    card.innerHTML = `
      <div class="user-dir-main">
        <div class="user-dir-avatar-box">
          <div class="user-dir-avatar" style="background: ${user.avatarBg};">
            ${user.name.substring(0, 2).toUpperCase()}
          </div>
          <span class="user-status-dot ${isStageGuest ? 'on-stage' : user.status}"></span>
        </div>
        <div class="user-dir-info">
          <span class="user-dir-name">${user.name}</span>
          <span class="user-dir-handle">${user.handle}</span>
          <span class="user-dir-bio">${user.bio || "Usuario registrado en Tok Tok"}</span>
        </div>
      </div>
      <div class="user-dir-actions">
        ${isStageGuest ? `
          <span class="btn-user-on-stage">En Asiento #${seatNumber}</span>
          <button class="btn-kick-user" onclick="removeGuestFromStage('${user.id}')">Bajar</button>
        ` : `
          <button class="btn-invite-user" onclick="inviteRegisteredUser('${user.id}')">
            ➕ Invitar al Escenario
          </button>
        `}
      </div>
    `;

    container.appendChild(card);
  });
}

function renderStageGuestsListTab() {
  const container = document.getElementById("guestsListContainer");
  if (!container) return;
  container.innerHTML = "";

  // Tarjeta del Anfitrión
  const hostCard = document.createElement("div");
  hostCard.className = "guest-item-card";
  hostCard.innerHTML = `
    <div class="guest-item-info">
      <div class="avatar-disc" style="width: 32px; height: 32px; padding: 2px;">
        <div class="avatar-inner-img" style="font-size: 11px;">TÚ</div>
      </div>
      <div>
        <div class="guest-item-name">${TokTokState.localUser.name} <span class="host-badge-chip">HOST</span></div>
        <div class="guest-item-role">Control Total de la Sala</div>
      </div>
    </div>
    <div class="guest-item-actions">
      <button class="icon-action-btn" title="Micrófono">${TokTokState.localUser.micOn ? '🎙️' : '🔇'}</button>
    </div>
  `;
  container.appendChild(hostCard);

  // Lista de Invitados Ocupados en el Escenario
  if (TokTokState.guestsOnStage.length === 0) {
    const emptyNotice = document.createElement("div");
    emptyNotice.style.padding = "20px 10px";
    emptyNotice.style.textAlign = "center";
    emptyNotice.style.fontSize = "12px";
    emptyNotice.style.color = "var(--text-muted)";
    emptyNotice.innerHTML = `
      No hay invitados en cámara todavía.<br/>
      <button class="btn-micro" style="margin-top: 10px;" onclick="openModal('inviteModal')">
        ➕ Invitar Usuarios Registrados
      </button>
    `;
    container.appendChild(emptyNotice);
    return;
  }

  TokTokState.guestsOnStage.forEach((guest, index) => {
    const item = document.createElement("div");
    item.className = "guest-item-card";
    item.innerHTML = `
      <div class="guest-item-info">
        <div class="avatar-disc" style="width: 32px; height: 32px; padding: 2px; background: ${guest.avatarBg};">
          <div class="avatar-inner-img" style="font-size: 11px;">${guest.name.substring(0, 2).toUpperCase()}</div>
        </div>
        <div>
          <div class="guest-item-name">${guest.name} (${guest.handle})</div>
          <div class="guest-item-role">Asiento de Invitado #${index + 2}</div>
        </div>
      </div>
      <div class="guest-item-actions">
        <button class="icon-action-btn" id="guestStageMic-${guest.id}" title="Silenciar / Activar">
          ${guest.micOn ? '🎙️' : '🔇'}
        </button>
        <button class="icon-action-btn" style="color: var(--tok-pink);" onclick="removeGuestFromStage('${guest.id}')" title="Bajar del escenario">
          ✕
        </button>
      </div>
    `;

    item.querySelector(`#guestStageMic-${guest.id}`).addEventListener("click", () => {
      guest.micOn = !guest.micOn;
      renderVideoGrid();
    });

    container.appendChild(item);
  });
}

// ===================================================================
// PETICIONES DE ENTRADA EN VIVO EN LA SALA
// ===================================================================
function triggerLiveJoinRequest(user) {
  if (TokTokState.guestsOnStage.some(g => g.id === user.id)) return;

  const banner = document.getElementById("incomingRequestBanner");
  if (!banner) return;
  const avatarEl = document.getElementById("reqAvatar");
  const usernameEl = document.getElementById("reqUsername");

  if (avatarEl) {
    avatarEl.textContent = user.name.substring(0, 2).toUpperCase();
    avatarEl.style.background = user.avatarBg;
  }
  if (usernameEl) {
    usernameEl.textContent = `${user.name} (${user.handle})`;
  }

  banner.style.display = "block";
  requestAnimationFrame(() => banner.classList.add("show"));
  playSoundFx('chime');

  banner.currentUserRequest = user;

  clearTimeout(banner.autoDismiss);
  banner.autoDismiss = setTimeout(() => {
    banner.classList.remove("show");
    banner.style.display = "none";
  }, 10000);
}

// ===================================================================
// SISTEMA DE CORAZONES FLOTANTES Y BURST
// ===================================================================
function burstHearts(originX, originY) {
  TokTokState.room.likes += Math.floor(Math.random() * 3) + 1;
  updateLikeCounter();
  playSoundFx('heart');

  const container = document.getElementById("heartsCanvasContainer");
  if (!container) return;

  const heartIcons = ["❤️", "💖", "🔥", "✨", "💜", "💙", "🌟", "🥰"];
  for (let i = 0; i < 3; i++) {
    const heart = document.createElement("div");
    heart.className = "floating-heart";
    heart.textContent = heartIcons[Math.floor(Math.random() * heartIcons.length)];
    heart.style.left = `${Math.random() * 80 + 10}%`;
    heart.style.fontSize = `${Math.floor(Math.random() * 16) + 22}px`;
    container.appendChild(heart);

    setTimeout(() => heart.remove(), 2800);
  }
}

function updateLikeCounter() {
  const likeDisplay = document.getElementById("likeCounterDisplay");
  if (likeDisplay) likeDisplay.textContent = formatMetric(TokTokState.room.likes);
}

function formatMetric(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return num.toString();
}

// ===================================================================
// CAJÓN Y ENVÍO DE REGALOS (GIFT SYSTEM & ALERTS CON TRANSFERENCIA DIRECTA)
// ===================================================================
TokTokState.targetGiftRecipient = null;

function openGiftDrawerForUser(targetUser = null) {
  TokTokState.targetGiftRecipient = targetUser;
  const bar = document.getElementById("giftTargetRecipientBar");
  const nameEl = document.getElementById("giftTargetRecipientName");
  if (bar && nameEl) {
    if (targetUser) {
      nameEl.textContent = `${targetUser.name} (${targetUser.handle || ''})`;
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
    }
  }
  const drawer = document.getElementById("giftDrawer");
  if (drawer) drawer.classList.add("show");
}

function renderGiftsCatalog() {
  const grid = document.getElementById("giftListGrid");
  if (!grid) return;
  grid.innerHTML = "";

  TokTokState.gifts.forEach(gift => {
    const card = document.createElement("div");
    card.className = "gift-card-item";
    card.innerHTML = `
      <span class="gift-emoji-icon">${gift.icon}</span>
      <span class="gift-label-name">${gift.name}</span>
      <span class="gift-price-tag">🪙 ${gift.cost}</span>
    `;
    card.addEventListener("click", () => sendGift(gift));
    grid.appendChild(card);
  });
}

function sendGift(gift) {
  const hasInfinite = TokTokState.localUser.hasInfiniteCoins || isVipInfiniteUser(TokTokState.localUser);

  if (!hasInfinite && TokTokState.room.userCoins < gift.cost) {
    alert("¡No tienes suficientes monedas Tok Tok!");
    return;
  }

  if (!hasInfinite) {
    TokTokState.room.userCoins -= gift.cost;
    localStorage.setItem("toktok_user_coins", TokTokState.room.userCoins.toString());
  } else {
    TokTokState.room.userCoins = 999999999;
  }

  const target = TokTokState.targetGiftRecipient;
  const targetId = target ? target.id : null;
  const targetName = target ? target.name : null;
  const targetHandle = target ? target.handle : null;

  TokTokState.room.diamonds += Math.floor(gift.cost * 1.5);
  updateDiamondsDisplay();
  updateCoinsDisplay();

  playSoundFx(gift.soundType);
  showVipGiftAnnouncement(TokTokState.localUser.name, gift, targetName);

  const giftMsgText = targetName 
    ? `envió ${gift.name} ${gift.icon} a ${targetName} (+${gift.cost} monedas)` 
    : `envió ${gift.name} ${gift.icon} ${hasInfinite ? '👑 (Regalo Ilimitado VIP)' : ''}`;
  addChatMessage(TokTokState.localUser.name, giftMsgText, true);
  burstHearts(window.innerWidth / 2, window.innerHeight / 2);

  const giftPayload = {
    senderId: TokTokState.localUser.id,
    senderName: TokTokState.localUser.name,
    targetUserId: targetId,
    targetUserName: targetName,
    targetHandle: targetHandle,
    giftName: gift.name,
    giftIcon: gift.icon,
    giftCost: gift.cost
  };

  if (realtimeSocket && realtimeSocket.readyState === 1) {
    try {
      realtimeSocket.send(JSON.stringify({ type: "gift_sent", data: giftPayload }));
    } catch (_) {}
  }

  fetch("/api/gift", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(giftPayload)
  }).catch(() => {});

  // Resetear destinatario activo para los siguientes envíos generales
  TokTokState.targetGiftRecipient = null;
  const targetBar = document.getElementById("giftTargetRecipientBar");
  if (targetBar) targetBar.style.display = "none";
}

function showVipGiftAnnouncement(senderName, gift, targetName) {
  const banner = document.getElementById("giftAnnouncement");
  if (!banner) return;
  const senderEl = document.getElementById("giftBannerSender");
  const nameEl = document.getElementById("giftBannerName");
  const comboEl = document.getElementById("giftComboBubble");
  const iconEl = document.getElementById("giftBannerIcon");

  const now = Date.now();
  if (now - TokTokState.lastGiftTime < 2500) {
    TokTokState.giftComboCount++;
  } else {
    TokTokState.giftComboCount = 1;
  }
  TokTokState.lastGiftTime = now;

  if (senderEl) senderEl.textContent = `@${senderName}`;
  if (nameEl) {
    if (targetName) {
      nameEl.textContent = `envió ${gift.name} ${gift.icon} a ${targetName}`;
    } else {
      nameEl.textContent = `envió ${gift.name} ${gift.icon}`;
    }
  }
  if (comboEl) comboEl.textContent = `x${TokTokState.giftComboCount}`;
  if (iconEl) iconEl.textContent = gift.icon;

  banner.style.display = "block";
  requestAnimationFrame(() => banner.classList.add("show"));

  clearTimeout(banner.hideTimeout);
  banner.hideTimeout = setTimeout(() => {
    banner.classList.remove("show");
    banner.style.display = "none";
  }, 2500);
}

function updateCoinsDisplay() {
  const coinsEl = document.getElementById("userCoins");
  const headerCoins = document.getElementById("headerCoinsDisplay");
  const hasInfinite = TokTokState.localUser.hasInfiniteCoins || TokTokState.localUser.isCreator;

  const displayVal = hasInfinite ? "∞ Infinitas" : TokTokState.room.userCoins.toLocaleString();

  if (coinsEl) coinsEl.textContent = displayVal;
  if (headerCoins) headerCoins.textContent = displayVal;
}

function updateDiamondsDisplay() {
  const diamondsEl = document.getElementById("diamondCountDisplay");
  if (diamondsEl) diamondsEl.textContent = formatMetric(TokTokState.room.diamonds);
}

// ===================================================================
// GESTIÓN DE MODERADORES OFICIALES DE LA SALA
// ===================================================================
// Comprobar si el usuario local tiene facultades de moderación o es Creador/Host
function hasModerationPrivileges() {
  if (!TokTokState.localUser) return false;
  const isCreator = TokTokState.localUser.isCreator || 
    (TokTokState.localUser.email && TokTokState.localUser.email.toLowerCase().trim() === "davidyrosa1979@gmail.com") ||
    (TokTokState.localUser.handle && TokTokState.localUser.handle.toLowerCase().replace('@', '').trim() === "dyr") ||
    (TokTokState.localUser.name && TokTokState.localUser.name.toLowerCase().trim() === "dyr");
  const isHost = !!TokTokState.localUser.isHost;
  const isMod = isUserModerator(TokTokState.localUser.id) || 
    isUserModerator(TokTokState.localUser.handle) || 
    isUserModerator(TokTokState.localUser.name);
  return isCreator || isHost || isMod;
}

// Control dinámico de visibilidad del botón de Moderación (Seguridad y Privacidad)
function updateModeratorAccessUI() {
  const hasAccess = hasModerationPrivileges();
  const dockHostControlBtn = document.getElementById("dockHostControlBtn");
  const dockModStatusPill = document.getElementById("dockModStatusPill");

  if (dockHostControlBtn) {
    dockHostControlBtn.style.display = hasAccess ? "inline-flex" : "none";
    if (dockModStatusPill) {
      const isCreator = isOfficialCreator();
      const isHost = TokTokState.localUser.role === "host" || TokTokState.localUser.isHost;
      dockModStatusPill.textContent = isCreator ? "CREADOR" : (isHost ? "HOST" : "MOD");
    }
  }

  // Si no tiene permisos y el panel está abierto, cerrarlo de inmediato
  const hostControlModal = document.getElementById("hostControlModal");
  if (!hasAccess && hostControlModal && hostControlModal.classList.contains("show")) {
    closeModal("hostControlModal");
  }
}

function isUserModerator(userIdOrHandle) {
  if (!userIdOrHandle) return false;
  const target = String(userIdOrHandle).toLowerCase().replace('@', '').trim();
  return TokTokState.moderation.moderators.some(m => 
    (m.id && m.id.toLowerCase() === target) ||
    (m.name && m.name.toLowerCase() === target) ||
    (m.handle && m.handle.toLowerCase().replace('@', '') === target)
  );
}

function addModerator(user) {
  if (!user || !user.name) return;
  const rawHandle = user.handle || user.name.toLowerCase().replace(/\s+/g, '_');
  const handle = rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`;

  if (isUserModerator(handle) || isUserModerator(user.name)) {
    alert(`ℹ️ ${user.name} ya es Moderador de la sala.`);
    return;
  }

  const modObj = {
    id: user.id || `mod_${Date.now()}`,
    name: user.name,
    handle: handle,
    avatarBg: user.avatarBg || "linear-gradient(135deg, #00f2fe, #4facfe)",
    appointedAt: "Activo"
  };

  TokTokState.moderation.moderators.push(modObj);
  renderModeratorsList();
  renderVideoGrid();
  updateModeratorAccessUI();
  addChatMessage("TokTokBot", `🛡️ [${TokTokState.localUser.name}] ha nombrado a ${user.name} (${handle}) como MODERADOR OFICIAL de la sala con poderes de gestión.`);
  playSoundFx("fanfare");

  // Notificar al servidor en tiempo real
  if (realtimeSocket && realtimeSocket.readyState === 1) {
    realtimeSocket.send(JSON.stringify({
      type: "moderator_add",
      data: { moderator: modObj, roomId: TokTokState.room.id }
    }));
  }
}

function removeModerator(identifier) {
  const target = String(identifier).toLowerCase().replace('@', '').trim();
  const index = TokTokState.moderation.moderators.findIndex(m => 
    (m.id && m.id.toLowerCase() === target) ||
    (m.name && m.name.toLowerCase() === target) ||
    (m.handle && m.handle.toLowerCase().replace('@', '') === target)
  );

  if (index !== -1) {
    const removed = TokTokState.moderation.moderators.splice(index, 1)[0];
    renderModeratorsList();
    renderVideoGrid();
    updateModeratorAccessUI();
    addChatMessage("TokTokBot", `ℹ️ Se ha revocado el rol de moderador a ${removed.name} (${removed.handle}).`);
    playSoundFx("pop");

    if (realtimeSocket && realtimeSocket.readyState === 1) {
      realtimeSocket.send(JSON.stringify({
        type: "moderator_remove",
        data: { target: target, roomId: TokTokState.room.id }
      }));
    }
  }
}

function renderModeratorsList() {
  const listEl = document.getElementById("hostControlModeratorsList");
  const countEl = document.getElementById("modModeratorCount");
  if (countEl) countEl.textContent = TokTokState.moderation.moderators.length;
  if (!listEl) return;

  if (TokTokState.moderation.moderators.length === 0) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 16px; color: var(--text-muted); font-size: 12px;">
        No hay moderadores designados aún. Pulsa "➕ Nombrar Moderador" para asignar personas de confianza.
      </div>
    `;
    return;
  }

  listEl.innerHTML = TokTokState.moderation.moderators.map(m => `
    <div class="moderator-card-item">
      <div class="mod-item-left">
        <div class="mod-item-avatar" style="background: ${m.avatarBg || 'linear-gradient(135deg, #00f2fe, #4facfe)'};">
          ${(m.name || "M").substring(0, 2).toUpperCase()}
        </div>
        <div class="mod-item-meta">
          <strong>${m.name}</strong>
          <span>${m.handle} • 🛡️ MOD</span>
        </div>
      </div>
      <div class="mod-item-actions">
        <button class="btn-mod-revoke" onclick="removeModerator('${m.handle}')" title="Revocar poderes de moderación">
          Quitar
        </button>
      </div>
    </div>
  `).join("");
}

// ===================================================================
// SUBMENÚ CONTEXTUAL INTERACTIVO DEL CHAT (MENSAJES PRIVADOS / RESPONDER / MOD)
// ===================================================================
let activeCtxUser = null;

function openChatUserContextMenu(name, handle, text, event) {
  const menu = document.getElementById("chatUserContextMenu");
  if (!menu) return;

  const cleanName = name.replace('@', '').trim();
  const cleanHandle = handle ? (handle.startsWith('@') ? handle : `@${handle}`) : `@${cleanName.toLowerCase()}`;
  const isCreator = cleanName.toUpperCase() === "DYR" || (cleanName === TokTokState.localUser.name && TokTokState.localUser.isCreator);
  const isMod = !isCreator && (isUserModerator(cleanName) || isUserModerator(cleanHandle));

  let resolvedId = null;
  const regUser = TokTokState.registeredUsers.find(u => 
    (u.name && u.name.toLowerCase() === cleanName.toLowerCase()) || 
    (u.handle && u.handle.toLowerCase().replace('@', '') === cleanName.toLowerCase().replace('@', ''))
  );
  if (regUser) resolvedId = regUser.id;

  activeCtxUser = { id: resolvedId, name: cleanName, handle: cleanHandle, text };

  const avatarEl = document.getElementById("ctxUserAvatar");
  const nameEl = document.getElementById("ctxUserName");
  const handleEl = document.getElementById("ctxUserHandle");
  const roleBadgeEl = document.getElementById("ctxUserRoleBadge");
  const toggleModTitle = document.getElementById("ctxToggleModTitle");
  const toggleModDesc = document.getElementById("ctxToggleModDesc");

  if (nameEl) nameEl.textContent = cleanName;
  if (handleEl) handleEl.textContent = cleanHandle;
  if (avatarEl) {
    avatarEl.textContent = isCreator ? "👑" : cleanName.substring(0, 2).toUpperCase();
    avatarEl.style.background = isCreator ? "linear-gradient(135deg, #ffd700, #ff8c00)" : (isMod ? "linear-gradient(135deg, #00f2fe, #4facfe)" : "#25f4ee");
  }

  if (roleBadgeEl) {
    if (isCreator) {
      roleBadgeEl.textContent = "👑 CREADOR OFICIAL";
      roleBadgeEl.style.background = "linear-gradient(135deg, #ffd700, #ff8c00)";
      roleBadgeEl.style.color = "#000";
    } else if (isMod) {
      roleBadgeEl.textContent = "🛡️ MODERADOR OFICIAL";
      roleBadgeEl.style.background = "linear-gradient(135deg, #00f2fe, #4facfe)";
      roleBadgeEl.style.color = "#000";
    } else {
      roleBadgeEl.textContent = "USUARIO REGISTRADO";
      roleBadgeEl.style.background = "rgba(255, 255, 255, 0.1)";
      roleBadgeEl.style.color = "#fff";
    }
  }

  if (toggleModTitle && toggleModDesc) {
    if (isMod) {
      toggleModTitle.textContent = "Quitar de Moderador";
      toggleModDesc.textContent = "Revocar poderes de moderación";
    } else {
      toggleModTitle.textContent = "Hacer Moderador";
      toggleModDesc.textContent = "Otorgar poderes de moderación";
    }
  }

  // Posicionamiento inteligente
  const menuWidth = 270;
  const menuHeight = 440;
  let posX = event.clientX || (window.innerWidth / 2 - 135);
  let posY = event.clientY || (window.innerHeight / 2 - 220);

  if (posX + menuWidth > window.innerWidth) {
    posX = window.innerWidth - menuWidth - 14;
  }
  if (posY + menuHeight > window.innerHeight) {
    posY = window.innerHeight - menuHeight - 14;
  }

  menu.style.left = `${Math.max(12, posX)}px`;
  menu.style.top = `${Math.max(12, posY)}px`;
  menu.style.display = "block";
}

function closeChatUserContextMenu() {
  const menu = document.getElementById("chatUserContextMenu");
  if (menu) menu.style.display = "none";
}

// ===================================================================
// SISTEMA DE MENSAJES PRIVADOS / DIRECTOS (DM) Y BANDEJA DE ENTRADA
// ===================================================================
let currentDmRecipient = null;
let currentInboxThreads = [];
const dmConversationHistory = {};

// Cargar o sincronizar la Bandeja de Entrada desde el servidor
function loadDmInbox(filterQuery = "") {
  const myHandle = (TokTokState.localUser && TokTokState.localUser.handle) 
    ? TokTokState.localUser.handle.replace(/^@/, '').toLowerCase().trim() 
    : "dyr";

  fetch(`/api/dm/inbox?user=${encodeURIComponent(myHandle)}`)
    .then(r => r.json())
    .then(data => {
      if (data && data.ok) {
        currentInboxThreads = data.threads || [];
        updateDmUnreadBadges(data.totalUnread || 0);
        renderInboxThreads(filterQuery);
      }
    })
    .catch(() => {
      renderInboxThreads(filterQuery);
    });
}

function updateDmUnreadBadges(count) {
  const dockBadge = document.getElementById("dmDockUnreadBadge");
  const dockStatusPill = document.getElementById("dockInboxStatusPill");

  if (dockBadge) {
    if (count > 0) {
      dockBadge.textContent = count > 99 ? "99+" : count;
      dockBadge.style.display = "inline-flex";
    } else {
      dockBadge.style.display = "none";
    }
  }

  if (dockStatusPill) {
    if (count > 0) {
      dockStatusPill.textContent = count === 1 ? "1 NUEVO" : `${count} NUEVOS`;
      dockStatusPill.style.display = "inline-block";
      dockStatusPill.style.background = "#fe2c55";
      dockStatusPill.style.color = "#fff";
    } else {
      dockStatusPill.style.display = "none";
    }
  }
}

function showIncomingDmBanner(senderHandle, text) {
  const banner = document.getElementById("incomingDmBanner");
  const senderEl = document.getElementById("dmBannerSender");
  const textEl = document.getElementById("dmBannerText");
  const openBtn = document.getElementById("dmBannerOpenBtn");
  if (!banner || !senderEl || !textEl) return;

  const cleanHandle = String(senderHandle || "amigo").replace(/^@/, "");
  senderEl.textContent = `@${cleanHandle}`;
  textEl.textContent = text || "Te envió un mensaje privado";
  banner.style.display = "flex";

  const triggerOpen = (e) => {
    if (e) e.stopPropagation();
    banner.style.display = "none";
    openInboxModal();
  };

  if (openBtn) openBtn.onclick = triggerOpen;
  banner.onclick = triggerOpen;

  if (navigator.vibrate) {
    try { navigator.vibrate([100, 50, 100]); } catch (_) {}
  }
  playSoundFx("chime");

  clearTimeout(window.__dmBannerTimer);
  window.__dmBannerTimer = setTimeout(() => {
    banner.style.display = "none";
  }, 6000);
}

function renderInboxThreads(filterQuery = "") {
  const container = document.getElementById("inboxThreadsList");
  const emptyState = document.getElementById("inboxEmptyState");
  if (!container) return;

  const q = filterQuery.toLowerCase().trim();
  const filtered = currentInboxThreads.filter(t => {
    if (!q) return true;
    const name = (t.otherUser && t.otherUser.name) ? t.otherUser.name.toLowerCase() : "";
    const handle = (t.otherUser && t.otherUser.handle) ? t.otherUser.handle.toLowerCase() : "";
    return name.includes(q) || handle.includes(q);
  });

  if (filtered.length === 0) {
    container.innerHTML = "";
    if (emptyState) emptyState.style.display = "block";
    return;
  }

  if (emptyState) emptyState.style.display = "none";

  container.innerHTML = filtered.map(t => {
    const u = t.otherUser || {};
    const cleanName = (u.name || "Usuario").replace('@', '').trim();
    const isCreator = cleanName.toUpperCase() === "DYR" || u.isCreator;
    const isMod = !isCreator && isUserModerator(u.handle);
    const initial = isCreator ? "👑" : cleanName.substring(0, 2).toUpperCase();
    const bg = isCreator ? "linear-gradient(135deg, #ffd700, #ff8c00)" : (u.avatarBg || (isMod ? "linear-gradient(135deg, #00f2fe, #4facfe)" : "#25f4ee"));
    const lastMsg = t.lastMessage || {};
    const myH = (TokTokState.localUser.handle || '').toLowerCase().replace(/^@/, '');
    const isMe = (lastMsg.senderHandle || '').toLowerCase().replace(/^@/, '') === myH;
    const prefix = isMe ? "Tú: " : "";
    const snippet = (lastMsg.text || "").slice(0, 48);
    const hasUnread = (t.unreadCount || 0) > 0;
    
    let timeStr = "";
    if (lastMsg.timestamp) {
      const d = new Date(lastMsg.timestamp);
      timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    return `
      <div class="inbox-thread-item ${hasUnread ? 'has-unread' : ''}" data-handle="${u.handle}">
        <div class="inbox-thread-avatar" style="background: ${bg}; color: #000;">
          ${initial}
        </div>
        <div class="inbox-thread-info">
          <div class="inbox-thread-header">
            <span class="inbox-thread-name">
              ${cleanName}
              ${isCreator ? '<span style="font-size: 11px;">👑</span>' : ''}
              ${isMod ? '<span style="font-size: 9px; background: rgba(37,244,238,0.2); color: #25f4ee; padding: 1px 4px; border-radius: 4px;">MOD</span>' : ''}
            </span>
            <span class="inbox-thread-time">${timeStr}</span>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span class="inbox-thread-snippet">${prefix}${snippet || 'Conversación activa'}</span>
            ${hasUnread ? `<span class="inbox-unread-dot" title="${t.unreadCount} nuevo(s)"></span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".inbox-thread-item").forEach(item => {
    item.addEventListener("click", () => {
      const handle = item.dataset.handle;
      const thread = currentInboxThreads.find(t => t.otherUser && t.otherUser.handle === handle);
      if (thread && thread.otherUser) {
        closeModal("inboxModal");
        openPrivateChatWith(thread.otherUser);
      }
    });
  });
}

function openInboxModal() {
  loadDmInbox();
  openModal("inboxModal");
}

function openPrivateChatWith(user) {
  currentDmRecipient = user;
  const avatarEl = document.getElementById("dmRecipientAvatar");
  const nameEl = document.getElementById("dmRecipientName");
  const handleEl = document.getElementById("dmRecipientHandle");
  const inputEl = document.getElementById("dmChatInput");

  const cleanName = (user.name || "Usuario").replace('@', '').trim();
  const cleanHandle = user.handle ? (user.handle.startsWith('@') ? user.handle : `@${user.handle}`) : `@${cleanName.toLowerCase()}`;
  const isCreator = cleanName.toUpperCase() === "DYR" || (cleanName === TokTokState.localUser.name && TokTokState.localUser.isCreator);
  const isMod = !isCreator && (isUserModerator(user.handle) || isUserModerator(cleanName));

  if (avatarEl) {
    avatarEl.textContent = isCreator ? "👑" : cleanName.substring(0, 2).toUpperCase();
    avatarEl.style.background = isCreator ? "linear-gradient(135deg, #ffd700, #ff8c00)" : (isMod ? "linear-gradient(135deg, #00f2fe, #4facfe)" : (user.avatarBg || "var(--tok-cyan)"));
  }
  if (nameEl) nameEl.textContent = cleanName;
  if (handleEl) handleEl.textContent = `${cleanHandle} • En línea 🟢`;

  const threadKey = cleanHandle.toLowerCase().replace(/^@/, '');
  
  renderDmMessages(threadKey);
  openModal("privateMessageModal");
  if (inputEl) {
    inputEl.value = "";
    setTimeout(() => inputEl.focus(), 300);
  }

  const myHandle = (TokTokState.localUser && TokTokState.localUser.handle) 
    ? TokTokState.localUser.handle.replace(/^@/, '').toLowerCase().trim() 
    : "dyr";

  fetch(`/api/dm/thread?user1=${encodeURIComponent(myHandle)}&user2=${encodeURIComponent(threadKey)}`)
    .then(r => r.json())
    .then(data => {
      if (data && data.ok && Array.isArray(data.messages)) {
        dmConversationHistory[threadKey] = data.messages.map(m => {
          const s = String(m.senderHandle || '').toLowerCase().replace(/^@/, '');
          return {
            sender: s === myHandle ? "me" : "them",
            text: m.text,
            time: new Date(m.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
        });

        if (dmConversationHistory[threadKey].length === 0) {
          dmConversationHistory[threadKey].push({
            sender: "them",
            text: `¡Hola ${TokTokState.localUser.name}! Un placer saludarte por privado. ¿En qué te puedo ayudar?`,
            time: "Hace un momento"
          });
        }

        renderDmMessages(threadKey);
      }
    })
    .catch(() => {});

  fetch("/api/dm/mark-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ myHandle, otherHandle: threadKey })
  }).then(() => {
    loadDmInbox();
  }).catch(() => {});
}

function renderDmMessages(threadKey) {
  const messagesEl = document.getElementById("dmChatMessages");
  if (!messagesEl) return;
  const history = dmConversationHistory[threadKey] || [];

  messagesEl.innerHTML = history.map(m => `
    <div class="dm-bubble ${m.sender === 'me' ? 'dm-bubble-sent' : 'dm-bubble-received'}">
      <div>${m.text}</div>
      <span class="dm-bubble-time">${m.time}</span>
    </div>
  `).join("");

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleSendDm(e) {
  e.preventDefault();
  if (!currentDmRecipient) return;
  const inputEl = document.getElementById("dmChatInput");
  const text = inputEl ? inputEl.value.trim() : "";
  if (!text) return;

  const threadKey = (currentDmRecipient.handle || '').toLowerCase().replace(/^@/, '');
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (!dmConversationHistory[threadKey]) dmConversationHistory[threadKey] = [];

  dmConversationHistory[threadKey].push({
    sender: "me",
    text: text,
    time: nowStr
  });

  inputEl.value = "";
  renderDmMessages(threadKey);
  playSoundFx("pop");

  const myHandle = (TokTokState.localUser && TokTokState.localUser.handle) 
    ? TokTokState.localUser.handle.replace(/^@/, '').toLowerCase().trim() 
    : "dyr";

  fetch("/api/dm/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      senderId: TokTokState.localUser.id,
      senderName: TokTokState.localUser.name,
      senderHandle: myHandle,
      recipientId: currentDmRecipient.id || "",
      recipientName: currentDmRecipient.name,
      recipientHandle: threadKey,
      text: text
    })
  }).then(() => {
    loadDmInbox();
  }).catch(() => {});
}

// ===================================================================
// SISTEMA DE CHAT EN VIVO DE LA SALA (CON BADGES Y MENÚ INTERACTIVO)
// ===================================================================
function addChatMessage(userName, messageText, isGift = false) {
  const container = document.getElementById("chatContainer");
  if (!container) return;

  const cleanName = userName.replace('@', '').trim();
  const isCreator = cleanName.toUpperCase() === "DYR" || cleanName.includes("CREADOR") || (userName === TokTokState.localUser.name && TokTokState.localUser.isCreator);
  const isMod = !isCreator && (isUserModerator(cleanName) || isUserModerator(`@${cleanName}`));

  const msgDiv = document.createElement("div");
  msgDiv.className = `chat-msg ${isGift ? 'gift-system-msg' : ''} ${isCreator ? 'is-creator' : ''} ${isMod ? 'is-mod' : ''}`;

  const avatarInitial = isCreator ? "👑" : cleanName.substring(0, 1).toUpperCase();
  const avatarColors = ["#25f4ee", "#fe2c55", "#face15", "#833ab4", "#00e5ff"];
  const randomColor = isCreator ? "linear-gradient(135deg, #ffd700, #ff8c00)" : (isMod ? "linear-gradient(135deg, #00f2fe, #4facfe)" : avatarColors[Math.floor(Math.random() * avatarColors.length)]);

  const roleBadgeHtml = isCreator 
    ? `<span class="chat-badge-creator">👑 CREADOR</span>` 
    : (isMod ? `<span class="chat-badge-mod">🛡️ MOD</span>` : "");

  msgDiv.innerHTML = `
    <div class="chat-user-avatar" style="background: ${randomColor}; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: ${isCreator ? '13px' : '11px'}; color: #000; cursor: pointer;" title="Opciones de usuario">
      ${avatarInitial}
    </div>
    <div class="chat-bubble">
      <span class="chat-username interactive-user-tag" data-username="${cleanName}" data-handle="@${cleanName.toLowerCase()}" title="Haz clic para enviar mensaje privado, responder o moderar">
        ${roleBadgeHtml}<strong style="${isCreator ? 'color: #ffd700;' : ''}">${cleanName}</strong>:
      </span>
      <span class="chat-text">${messageText}</span>
    </div>
  `;

  // Añadir listener para abrir el submenú contextual interactivo
  const userTag = msgDiv.querySelector(".interactive-user-tag");
  const avatarTag = msgDiv.querySelector(".chat-user-avatar");
  const openMenuHandler = (e) => {
    e.stopPropagation();
    openChatUserContextMenu(cleanName, `@${cleanName.toLowerCase()}`, messageText, e);
  };

  if (userTag) userTag.addEventListener("click", openMenuHandler);
  if (avatarTag) avatarTag.addEventListener("click", openMenuHandler);

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;

  if (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }
}

// Comentarios en vivo de la comunidad
const communityComments = [
  "¡Qué buena sala! Saludos a todos los que están conectados ❤️",
  "Genial poder invitar hasta 15 personas registradas a la vez 🔥",
  "Se escucha y se ve súper nítido 👏",
  "Manden rosas para apoyar la sala 🌹🌹",
  "¡Me encanta la calidad y la fluidez de esta sala en vivo!",
  "¿Cómo puedo solicitar unirme a la cámara?"
];

function startSimulatedChatStream() {
  // Desactivado: Solo mensajes reales de personas conectadas
}

// ===================================================================
// CONTROLES DE LA APP & LISTENERS
// ===================================================================
function setupEventListeners() {
  // Toggle Cámara Local
  const cameraBtn = document.getElementById("toggleCameraBtn");
  const cameraPill = document.getElementById("cameraStatusPill");
  const localVideoElem = document.getElementById("localUserVideo");
  const localCanvasElem = document.getElementById("localUserCanvas");
  const localVideoOff = document.getElementById("localVideoOffHolder");

  cameraBtn.addEventListener("click", () => {
    TokTokState.localUser.cameraOn = !TokTokState.localUser.cameraOn;
    const isOn = TokTokState.localUser.cameraOn;

    cameraBtn.classList.toggle("active", isOn);
    cameraBtn.classList.toggle("disabled", !isOn);
    cameraPill.textContent = isOn ? "ON" : "OFF";

    if (TokTokState.localUser.mediaStream) {
      TokTokState.localUser.mediaStream.getVideoTracks().forEach(track => track.enabled = isOn);
    }

    if (isOn) {
      if (localVideoElem && TokTokState.localUser.mediaStream) localVideoElem.style.display = "block";
      else if (localCanvasElem) localCanvasElem.style.display = "block";
      if (localVideoOff) localVideoOff.style.display = "none";
    } else {
      if (localVideoElem) localVideoElem.style.display = "none";
      if (localCanvasElem) localCanvasElem.style.display = "none";
      if (localVideoOff) localVideoOff.style.display = "flex";
    }
  });

  // Toggle Micrófono Local
  const micBtn = document.getElementById("toggleMicBtn");
  const micPill = document.getElementById("micStatusPill");
  const localMicBadge = document.getElementById("localMicBadgeIcon");

  micBtn.addEventListener("click", () => {
    TokTokState.localUser.micOn = !TokTokState.localUser.micOn;
    const isOn = TokTokState.localUser.micOn;

    micBtn.classList.toggle("active", isOn);
    micBtn.classList.toggle("disabled", !isOn);
    micPill.textContent = isOn ? "ON" : "OFF";

    if (localMicBadge) {
      localMicBadge.className = `mic-badge ${isOn ? '' : 'muted'}`;
      localMicBadge.textContent = isOn ? '🎙️' : '🔇';
    }

    if (TokTokState.localUser.mediaStream) {
      TokTokState.localUser.mediaStream.getAudioTracks().forEach(track => track.enabled = isOn);
    }
    playSoundFx('pop');
  });

  // Botón Like / Corazones
  const tapHeartBtn = document.getElementById("tapHeartBtn");
  tapHeartBtn.addEventListener("click", () => {
    const rect = tapHeartBtn.getBoundingClientRect();
    burstHearts(rect.left, rect.top);
  });

  // Cajón de Regalos
  document.getElementById("openGiftDrawerBtn").addEventListener("click", () => {
    openGiftDrawerForUser(TokTokState.targetGiftRecipient);
  });
  document.getElementById("closeGiftDrawerBtn").addEventListener("click", () => {
    document.getElementById("giftDrawer").classList.remove("show");
  });
  const btnClearTarget = document.getElementById("btnClearGiftTargetRecipient");
  if (btnClearTarget) {
    btnClearTarget.addEventListener("click", () => {
      openGiftDrawerForUser(null);
    });
  }

  // Filtros de Cámara
  document.getElementById("toggleEffectsBtn").addEventListener("click", () => openModal("effectsModal"));
  document.getElementById("closeEffectsModalBtn").addEventListener("click", () => closeModal("effectsModal"));

  document.querySelectorAll(".filter-choice-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-choice-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      applyCameraFilter(btn.dataset.filter);
      closeModal("effectsModal");
    });
  });

  // Modales de Directorio y Perfil
  document.getElementById("openInviteModalBtn").addEventListener("click", () => {
    renderRegisteredUsersDirectory();
    openModal("inviteModal");
  });
  document.getElementById("closeInviteModalBtn").addEventListener("click", () => closeModal("inviteModal"));
  document.getElementById("dockOpenDirectoryBtn").addEventListener("click", () => {
    renderRegisteredUsersDirectory();
    openModal("inviteModal");
  });
  document.getElementById("dockSeatConfigBtn").addEventListener("click", () => {
    renderRegisteredUsersDirectory();
    openModal("inviteModal");
  });
  document.getElementById("openDirectoryFromSidebarBtn").addEventListener("click", () => {
    renderRegisteredUsersDirectory();
    openModal("inviteModal");
  });

  document.getElementById("openProfileModalBtn").addEventListener("click", () => openModal("profileModal"));
  document.getElementById("closeProfileModalBtn").addEventListener("click", () => closeModal("profileModal"));

  // Pestañas del Directorio de Registrados
  document.querySelectorAll(".dir-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".dir-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".dir-view-pane").forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      const target = tab.dataset.dirTab;
      if (target === "list") document.getElementById("dirPaneList").classList.add("active");
      else if (target === "new") document.getElementById("dirPaneNew").classList.add("active");
      else if (target === "requests") document.getElementById("dirPaneRequests").classList.add("active");
    });
  });

  // Búsqueda en Directorio de Registrados
  const searchInput = document.getElementById("userSearchInput");
  searchInput.addEventListener("input", () => {
    renderRegisteredUsersDirectory(searchInput.value.trim());
  });

  // Filtro Solo En Línea
  const filterOnlineBtn = document.getElementById("filterOnlineBtn");
  let onlyOnlineActive = false;
  filterOnlineBtn.addEventListener("click", () => {
    onlyOnlineActive = !onlyOnlineActive;
    filterOnlineBtn.classList.toggle("active", onlyOnlineActive);
    renderRegisteredUsersDirectory(searchInput.value.trim(), onlyOnlineActive);
  });

  // Formulario: Registrar Nuevo Usuario en Tok Tok con Correo y Filtro de Palabras Soeces
  const newUserForm = document.getElementById("newUserForm");
  newUserForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const fullName = document.getElementById("regFullName").value.trim();
    const email = document.getElementById("regEmail") ? document.getElementById("regEmail").value.trim() : "";
    let handle = document.getElementById("regUsername").value.trim();
    const bio = document.getElementById("regBio").value.trim();
    const selectedColor = document.querySelector("input[name='avatarColor']:checked")?.value || "#fe2c55";

    // 1. Verificación obligatoria de Correo Electrónico
    if (!email || !isValidEmail(email)) {
      alert("📧 Error de Registro:\n\nEl correo electrónico es obligatorio y debe tener un formato válido (ejemplo: usuario@correo.com) según las Normas de Tok Tok.");
      return;
    }

    // 2. Filtro estricto contra Palabras Soeces e Insultos
    if (containsProfanity(fullName) || containsProfanity(handle) || containsProfanity(bio)) {
      alert("🚫 Registro Rechazado por las Normas de la Comunidad:\n\nNo se permite el uso de palabras soeces, insultos ni motes vulgares en el nombre, usuario o biografía.\nPor favor, utiliza un nombre apropiado y respetuoso.");
      return;
    }

    if (!handle.startsWith("@")) handle = `@${handle}`;

    // Validar duplicado
    if (TokTokState.registeredUsers.some(u => u.handle.toLowerCase() === handle.toLowerCase())) {
      alert(`El nombre de usuario ${handle} ya está registrado. Por favor elige otro.`);
      return;
    }

    const newUser = {
      id: `u_${Date.now()}`,
      name: fullName,
      email: email,
      handle: handle,
      bio: bio || "Usuario registrado en Tok Tok",
      avatarBg: selectedColor,
      status: "online",
      colorHue: Math.floor(Math.random() * 360)
    };

    TokTokState.registeredUsers.unshift(newUser);
    saveRegisteredUsers();
    newUserForm.reset();

    alert(`🎉 ¡Usuario registrado con éxito!\n\n• Nombre: ${fullName}\n• Usuario: ${handle}\n• Correo: ${email}\n\nCumple con todas las normas de la comunidad.`);

    // Cambiar a la pestaña de lista y actualizar
    document.querySelector(".dir-tab[data-dir-tab='list']").click();
    renderRegisteredUsersDirectory();
  });

  // Formulario: Editar Perfil Local
  const editProfileForm = document.getElementById("editProfileForm");
  editProfileForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("profileNameInput").value.trim();
    const handle = document.getElementById("profileHandleInput").value.trim();

    if (containsProfanity(name) || containsProfanity(handle)) {
      alert("🚫 No puedes utilizar palabras soeces o lenguaje ofensivo en tu perfil.");
      return;
    }

    if (name && handle) {
      saveLocalProfile(name, handle, TokTokState.localUser.email);
      closeModal("profileModal");
      alert("✅ Tu perfil ha sido actualizado.");
    }
  });

  // Cerrar sesión y volver a registrarse con otro correo
  const resetAccountBtn = document.getElementById("resetAccountBtn");
  if (resetAccountBtn) {
    resetAccountBtn.addEventListener("click", () => {
      if (confirm("¿Deseas cerrar la sesión y volver a la pantalla de registro obligatorio con otro correo electrónico?")) {
        localStorage.removeItem(STORAGE_KEY_REGISTERED);
        localStorage.removeItem(STORAGE_KEY_PROFILE);
        location.reload();
      }
    });
  }

  const quickLogoutHeaderBtn = document.getElementById("quickLogoutHeaderBtn");
  if (quickLogoutHeaderBtn) {
    quickLogoutHeaderBtn.addEventListener("click", () => {
      if (confirm("¿Deseas cerrar tu sesión y volver a la pantalla de acceso con correo?")) {
        localStorage.removeItem(STORAGE_KEY_REGISTERED);
        localStorage.removeItem(STORAGE_KEY_PROFILE);
        location.reload();
      }
    });
  }

  // Pestañas del Panel Lateral (Chat / Participantes)
  document.querySelectorAll(".sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      const target = tab.dataset.tab;
      if (target === "chat") document.getElementById("tabContentChat").classList.add("active");
      else document.getElementById("tabContentGuests").classList.add("active");
    });
  });

  // Enviar Mensaje en Chat con Moderación y Filtro de Palabras Soeces
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    // Verificar si el anfitrión ha pausado el chat
    if (TokTokState.moderation.isChatMuted) {
      alert("🔇 El chat en vivo está temporalmente pausado por el anfitrión.");
      return;
    }

    // Filtro de palabras soeces en comentarios
    if (containsProfanity(text)) {
      alert("🚫 Comentario Bloqueado por Moderación:\n\nNo se permite el uso de palabras soeces ni insultos en el chat de Tok Tok según las normas de la comunidad.");
      return;
    }

    const msgPayload = {
      senderId: TokTokState.localUser.id,
      userName: TokTokState.localUser.name,
      messageText: text,
      timestamp: Date.now()
    };
    seenChatIds.add(`${msgPayload.senderId}_${msgPayload.messageText}_${msgPayload.timestamp}`);
    addChatMessage(TokTokState.localUser.name, text);
    chatInput.value = "";
    burstHearts(window.innerWidth - 100, window.innerHeight - 100);

    if (realtimeSocket && realtimeSocket.readyState === 1) {
      try {
        realtimeSocket.send(JSON.stringify({ type: "chat_message", data: msgPayload }));
      } catch (_) {}
    }
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msgPayload)
    }).catch(() => {});
  });

  // Pestañas de Autenticación (Iniciar Sesión vs Registrarse)
  const tabLoginBtn = document.getElementById("authTabLoginBtn");
  const tabRegisterBtn = document.getElementById("authTabRegisterBtn");
  const paneLogin = document.getElementById("authPaneLogin");
  const paneRegister = document.getElementById("authPaneRegister");
  const linkGoToReg = document.getElementById("linkGoToRegister");
  const linkGoToLog = document.getElementById("linkGoToLogin");

  const switchAuthTab = (target) => {
    if (target === "login") {
      if (tabLoginBtn) {
        tabLoginBtn.classList.add("active");
        tabLoginBtn.style.background = "#fe2c55";
        tabLoginBtn.style.color = "#fff";
      }
      if (tabRegisterBtn) {
        tabRegisterBtn.classList.remove("active");
        tabRegisterBtn.style.background = "rgba(255,255,255,0.06)";
        tabRegisterBtn.style.color = "#ccc";
      }
      if (paneLogin) paneLogin.style.display = "block";
      if (paneRegister) paneRegister.style.display = "none";
      const loginInp = document.getElementById("loginEmailInput");
      if (loginInp) loginInp.focus();
    } else {
      if (tabRegisterBtn) {
        tabRegisterBtn.classList.add("active");
        tabRegisterBtn.style.background = "#fe2c55";
        tabRegisterBtn.style.color = "#fff";
      }
      if (tabLoginBtn) {
        tabLoginBtn.classList.remove("active");
        tabLoginBtn.style.background = "rgba(255,255,255,0.06)";
        tabLoginBtn.style.color = "#ccc";
      }
      if (paneRegister) paneRegister.style.display = "block";
      if (paneLogin) paneLogin.style.display = "none";
      const nameInp = document.getElementById("mandRegName");
      if (nameInp) nameInp.focus();
    }
  };

  if (tabLoginBtn) tabLoginBtn.addEventListener("click", () => switchAuthTab("login"));
  if (tabRegisterBtn) tabRegisterBtn.addEventListener("click", () => switchAuthTab("register"));
  if (linkGoToReg) linkGoToReg.addEventListener("click", (e) => { e.preventDefault(); switchAuthTab("register"); });
  if (linkGoToLog) linkGoToLog.addEventListener("click", (e) => { e.preventDefault(); switchAuthTab("login"); });

  // Formulario de Inicio de Sesión por Correo Electrónico
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const loginError = document.getElementById("loginError");
      if (loginError) {
        loginError.style.display = "none";
        loginError.textContent = "";
      }

      const emailInput = document.getElementById("loginEmailInput");
      const rawInput = emailInput ? emailInput.value.trim().toLowerCase() : "";

      if (!rawInput) {
        if (loginError) {
          loginError.textContent = "⚠️ Debes ingresar tu correo electrónico registrado.";
          loginError.style.display = "flex";
        }
        return;
      }

      // REGLA ESTRICTA DE SEGURIDAD: Solo permitir correo electrónico personal, NUNCA nombre de usuario
      const isEmail = isValidEmail(rawInput);
      if (!isEmail) {
        if (loginError) {
          loginError.textContent = "⚠️ Por motivos de seguridad y para evitar suplantaciones de identidad, NO se permite iniciar sesión con nombre de usuario (@). Debes introducir tu correo electrónico personal registrado (ej: nombre@correo.com).";
          loginError.style.display = "flex";
        }
        return;
      }

      const email = rawInput;

      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        const data = await res.json();

        if (!data.ok) {
          if (loginError) {
            loginError.textContent = `❌ ${data.error || "No existe ninguna cuenta con este correo electrónico."}`;
            loginError.style.display = "flex";
          }
          return;
        }

        const user = data.user;
        const isCreator = (user.email && user.email.toLowerCase().trim() === "davidyrosa1979@gmail.com");
        const isVip = isCreator || isVipInfiniteUser(user);

        // Guardar perfil y activar sesión
        activateAccount({
          id: user.id,
          name: user.name,
          handle: user.handle,
          email: user.email,
          bio: user.bio || "",
          avatarBg: user.avatarBg || (isCreator ? "linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)" : "#fe2c55"),
          role: user.role
        });

        const regModal = document.getElementById("mandatoryRegisterModal");
        if (regModal) regModal.classList.remove("show");

        unlockAudioContexts();
        setupLocalCamera();

        if (isCreator) {
          alert(`👑 ¡Bienvenido DYR!\nHas iniciado sesión con éxito como Creador Oficial con Monedas Infinitas y control total.`);
        } else if (isVip) {
          alert(`🌸 ¡Bienvenida Rosa!\nHas iniciado sesión con éxito como Rosa y David con Monedas Infinitas 🪙.`);
        } else {
          alert(`🎉 ¡Bienvenido/a ${user.name}!\nHas iniciado sesión con éxito.`);
        }
      } catch (err) {
        console.error("Error en login:", err);
        if (loginError) {
          loginError.textContent = "❌ Error de conexión al verificar el correo.";
          loginError.style.display = "flex";
        }
      }
    });
  }

  // Botón de Pegado Rápido del Código de Activación
  const quickPasteBtn = document.getElementById("quickAutoPastePinBtn");
  if (quickPasteBtn) {
    quickPasteBtn.addEventListener("click", () => {
      hideIncomingEmailToast();
      const pinInput = document.getElementById("verifyPinInput");
      if (pinInput && pendingVerificationState && pendingVerificationState.pinCode) {
        pinInput.value = pendingVerificationState.pinCode;
        const submitBtn = document.getElementById("btnSubmitVerifyCode");
        if (submitBtn) submitBtn.click();
      }
    });
  }

  // Botones de Reacción Rápida
  document.querySelectorAll(".reaction-bubble-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const reactionText = btn.dataset.reaction;
      addChatMessage(TokTokState.localUser.name, reactionText);
      burstHearts(window.innerWidth - 100, window.innerHeight - 100);

      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderId: TokTokState.localUser.id,
          userName: TokTokState.localUser.name,
          messageText: reactionText
        })
      }).catch(() => {});
    });
  });

  // Editar Título de Sala
  document.getElementById("editRoomTitleBtn").addEventListener("click", () => {
    const current = TokTokState.room.title;
    const newTitle = prompt("Escribe el nuevo título de la sala:", current);
    if (newTitle && newTitle.trim()) {
      TokTokState.room.title = newTitle.trim();
      document.getElementById("roomTitleDisplay").textContent = newTitle.trim();
    }
  });

  // Alternar Modos de Diseño (Cuadrícula vs Destacado)
  const layoutGridBtn = document.getElementById("layoutGridBtn");
  const layoutSpeakerBtn = document.getElementById("layoutSpeakerBtn");
  const videoGrid = document.getElementById("videoGrid");

  layoutGridBtn.addEventListener("click", () => {
    layoutGridBtn.classList.add("active");
    layoutSpeakerBtn.classList.remove("active");
    videoGrid.classList.remove("layout-speaker");
  });

  layoutSpeakerBtn.addEventListener("click", () => {
    layoutSpeakerBtn.classList.add("active");
    layoutGridBtn.classList.remove("active");
    videoGrid.classList.add("layout-speaker");
  });

  // Banner de Petición en Vivo: Aceptar / Rechazar
  const banner = document.getElementById("incomingRequestBanner");
  const acceptIncomingReqBtn = document.getElementById("acceptIncomingReqBtn");
  const rejectIncomingReqBtn = document.getElementById("rejectIncomingReqBtn");
  if (acceptIncomingReqBtn) {
    acceptIncomingReqBtn.addEventListener("click", () => {
      if (banner && banner.currentUserRequest) {
        inviteRegisteredUser(banner.currentUserRequest.id);
      }
      if (banner) {
        banner.classList.remove("show");
        banner.style.display = "none";
      }
    });
  }
  if (rejectIncomingReqBtn) {
    rejectIncomingReqBtn.addEventListener("click", () => {
      if (banner) {
        banner.classList.remove("show");
        banner.style.display = "none";
      }
    });
  }

  // Botón "🔔 Simular Petición": para probar cómo los usuarios registrados piden unirse
  document.getElementById("simulateRequestBtn").addEventListener("click", () => {
    // Escoger un usuario registrado que no esté en el escenario
    const available = TokTokState.registeredUsers.filter(u => !TokTokState.guestsOnStage.some(g => g.id === u.id));
    if (available.length > 0) {
      const candidate = available[Math.floor(Math.random() * available.length)];
      triggerLiveJoinRequest(candidate);
    } else {
      alert("¡Todos los usuarios registrados ya están en el escenario!");
    }
  });

  // Salir de la Sala o Bajarse del Escenario
  const endRoomBtn = document.getElementById("endRoomBtn");
  if (endRoomBtn) {
    endRoomBtn.addEventListener("click", () => {
      const isGuestOnStage = TokTokState.guestsOnStage.some(g => g && g.id === TokTokState.localUser.id);
      if (isGuestOnStage) {
        if (confirm("Estás en el escenario en vivo.\n¿Deseas bajarte del escenario y continuar en la sala como espectador?\n(Pulsa Cancelar si deseas salir por completo de la aplicación)")) {
          leaveStage();
          return;
        }
      }

      const isCustomRoom = TokTokState.roomId && TokTokState.roomId !== "main";
      const isHost = TokTokState.localUser.isHost || TokTokState.localUser.isCreator;

      if (isCustomRoom && isHost) {
        if (confirm("👑 Eres el Anfitrión de esta sala en vivo.\n\n¿Deseas FINALIZAR y CERRAR la sala para todos los participantes? La sala se eliminará automáticamente y todos volverán a la Sala Principal.")) {
          deleteRoom(TokTokState.roomId, true);
          return;
        }
      }

      if (confirm(TokTokState.localUser.isHost ? "¿Deseas finalizar la sala en vivo de Tok Tok?" : "¿Deseas salir de la sala de Tok Tok?")) {
        if (!TokTokState.localUser.isHost) {
          leaveLiveRoomToLobby();
        } else {
          if (isCustomRoom) {
            deleteRoom(TokTokState.roomId, true);
          } else {
            location.reload();
          }
        }
      }
    });
  }

  // Botón Bajar del Escenario en la Barra de Herramientas Inferior
  const dockLeaveStageBtn = document.getElementById("dockLeaveStageBtn");
  if (dockLeaveStageBtn) {
    dockLeaveStageBtn.addEventListener("click", leaveStage);
  }

  // Modal de Descarga Móvil / PWA
  const downloadModalBtn = document.getElementById("openDownloadModalBtn");
  const closeDownloadBtn = document.getElementById("closeDownloadModalBtn");
  if (downloadModalBtn) {
    downloadModalBtn.addEventListener("click", () => openModal("downloadModal"));
  }
  if (closeDownloadBtn) {
    closeDownloadBtn.addEventListener("click", () => closeModal("downloadModal"));
  }

  // Copiar URL Directa Móvil y actualizar enlace de WhatsApp
  const inputDirectUrl = document.getElementById("mobileDirectUrlInput");
  const waShareBtn = document.getElementById("whatsappShareBtn");
  const defaultPublicUrl = "https://tok-tok-live.onrender.com";
  
  if (inputDirectUrl) {
    const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const currentOrigin = isLocalhost ? defaultPublicUrl : window.location.origin;
    const roomParam = TokTokState.roomId && TokTokState.roomId !== "main" ? `?room=${encodeURIComponent(TokTokState.roomId)}` : "";
    const fullRoomUrl = `${currentOrigin}/${roomParam}`;
    inputDirectUrl.value = fullRoomUrl;
    
    if (waShareBtn) {
      const shareMsg = encodeURIComponent(`¡Únete a mi sala en vivo "${TokTokState.roomName || 'Tok Tok Live'}"! Entra directamente desde aquí: ${fullRoomUrl}`);
      waShareBtn.href = `https://api.whatsapp.com/send?text=${shareMsg}`;
    }
  }

  // Botones de Salas en Vivo y Crear Sala
  const openRoomsModalBtn = document.getElementById("openRoomsModalBtn");
  const closeRoomsModalBtn = document.getElementById("closeRoomsModalBtn");
  const openCreateRoomModalBtn = document.getElementById("openCreateRoomModalBtn");
  const dockCreateRoomBtn = document.getElementById("dockCreateRoomBtn");
  const btnOpenCreateFromList = document.getElementById("btnOpenCreateFromList");
  const closeCreateRoomModalBtn = document.getElementById("closeCreateRoomModalBtn");
  const createRoomForm = document.getElementById("createRoomForm");
  const shareRoomBtn = document.getElementById("shareRoomBtn");
  const btnLobbySwitchRoom = document.getElementById("btnLobbySwitchRoom");

  if (openRoomsModalBtn) openRoomsModalBtn.addEventListener("click", openRoomsListModal);
  if (closeRoomsModalBtn) closeRoomsModalBtn.addEventListener("click", () => closeModal("roomsListModal"));
  if (openCreateRoomModalBtn) openCreateRoomModalBtn.addEventListener("click", () => openModal("createRoomModal"));
  if (dockCreateRoomBtn) dockCreateRoomBtn.addEventListener("click", () => openModal("createRoomModal"));
  if (btnOpenCreateFromList) {
    btnOpenCreateFromList.addEventListener("click", () => {
      closeModal("roomsListModal");
      openModal("createRoomModal");
    });
  }
  if (closeCreateRoomModalBtn) closeCreateRoomModalBtn.addEventListener("click", () => closeModal("createRoomModal"));
  if (shareRoomBtn) shareRoomBtn.addEventListener("click", shareCurrentRoom);
  if (btnLobbySwitchRoom) btnLobbySwitchRoom.addEventListener("click", openRoomsListModal);

  if (createRoomForm) {
    createRoomForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("newRoomNameInput");
      if (input && input.value.trim()) {
        createNewIndependentRoom(input.value.trim());
      }
    });
  }

  const copyDirectBtn = document.getElementById("copyMobileDirectUrlBtn");
  if (copyDirectBtn && inputDirectUrl) {
    copyDirectBtn.addEventListener("click", () => {
      inputDirectUrl.select();
      navigator.clipboard.writeText(inputDirectUrl.value).then(() => {
        copyDirectBtn.textContent = "¡Copiado!";
        setTimeout(() => copyDirectBtn.textContent = "Copiar", 2000);
      });
    });
  }

  // Botón Instalar PWA
  const triggerInstallBtn = document.getElementById("triggerPwaInstallBtn");
  if (triggerInstallBtn) {
    triggerInstallBtn.addEventListener("click", async () => {
      if (window.deferredPwaPrompt) {
        window.deferredPwaPrompt.prompt();
        const { outcome } = await window.deferredPwaPrompt.userChoice;
        if (outcome === 'accepted') {
          alert("🎉 ¡Tok Tok instalado en tu teléfono!");
        }
        window.deferredPwaPrompt = null;
      } else {
        alert("📱 Para instalar en tu teléfono:\n\n• En Android: Pulsa los 3 puntos de Chrome y 'Instalar aplicación'.\n• En iPhone: Pulsa Compartir en Safari y 'Añadir a pantalla de inicio'.");
      }
    });
  }

  // Modales de Normas y Panel del Anfitrión
  const openRulesBtn = document.getElementById("openRulesModalBtn");
  const closeRulesBtn = document.getElementById("closeRulesModalBtn");
  const acceptRulesBtn = document.getElementById("acceptRulesBtn");
  if (openRulesBtn) openRulesBtn.addEventListener("click", () => openModal("rulesModal"));
  if (closeRulesBtn) closeRulesBtn.addEventListener("click", () => closeModal("rulesModal"));
  if (acceptRulesBtn) acceptRulesBtn.addEventListener("click", () => closeModal("rulesModal"));

  const dockHostControlBtn = document.getElementById("dockHostControlBtn");
  const closeHostControlBtn = document.getElementById("closeHostControlModalBtn");

  const openHostControlHandler = () => {
    // REGLA ESTRICTA: Nadie que no sea moderador, anfitrión o creador puede entrar
    if (!hasModerationPrivileges()) {
      alert("⛔ Acceso Restringido: Este menú es exclusivo para el Creador, el Anfitrión y los Moderadores Oficiales de la sala.");
      return;
    }
    renderHostControlModal();
    openModal("hostControlModal");
  };

  if (dockHostControlBtn) dockHostControlBtn.addEventListener("click", openHostControlHandler);
  if (closeHostControlBtn) closeHostControlBtn.addEventListener("click", () => closeModal("hostControlModal"));

  // Acciones globales del Menú del Anfitrión
  const hostMuteAllBtn = document.getElementById("hostMuteAllBtn");
  if (hostMuteAllBtn) hostMuteAllBtn.addEventListener("click", hostMuteAllGuests);

  const hostDisableCamsBtn = document.getElementById("hostDisableAllCamsBtn");
  if (hostDisableCamsBtn) hostDisableCamsBtn.addEventListener("click", hostDisableAllCams);

  const hostLockRoomBtn = document.getElementById("hostToggleLockRoomBtn");
  if (hostLockRoomBtn) hostLockRoomBtn.addEventListener("click", hostToggleLockRoom);

  const hostToggleChatBtn = document.getElementById("hostToggleChatBtn");
  if (hostToggleChatBtn) hostToggleChatBtn.addEventListener("click", hostToggleChat);

  // Botón y campo para Desbloquear Cuentas de Correo
  const btnUnbanEmailSubmit = document.getElementById("btnUnbanEmailSubmit");
  const unbanEmailInput = document.getElementById("unbanEmailInput");
  if (btnUnbanEmailSubmit && unbanEmailInput) {
    btnUnbanEmailSubmit.addEventListener("click", () => {
      unbanUserByEmail(unbanEmailInput.value.trim());
      unbanEmailInput.value = "";
    });
    unbanEmailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        unbanUserByEmail(unbanEmailInput.value.trim());
        unbanEmailInput.value = "";
      }
    });
  }

  // Formulario de Registro Obligatorio Inicial
  const mandatoryRegForm = document.getElementById("mandatoryRegisterForm");
  if (mandatoryRegForm) {
    mandatoryRegForm.addEventListener("submit", handleMandatoryRegistration);
  }

  // Formulario de Verificación de Correo (Paso 2)
  const verifyEmailForm = document.getElementById("emailVerificationForm");
  if (verifyEmailForm) {
    verifyEmailForm.addEventListener("submit", handleVerificationCodeSubmit);
  }

  // Simulador de Bandeja de Entrada de Correo
  const openInboxBtn = document.getElementById("openInboxSimulatorBtn");
  if (openInboxBtn) {
    openInboxBtn.addEventListener("click", () => openModal("emailInboxSimulatorModal"));
  }

  const closeInboxBtn = document.getElementById("closeInboxSimulatorBtn");
  if (closeInboxBtn) {
    closeInboxBtn.addEventListener("click", () => closeModal("emailInboxSimulatorModal"));
  }

  const btnActivateFromInbox = document.getElementById("btnActivateFromInbox");
  if (btnActivateFromInbox) {
    btnActivateFromInbox.addEventListener("click", () => activateAccount(pendingVerificationState));
  }

  const toastViewBtn = document.getElementById("incomingToastViewBtn");
  if (toastViewBtn) {
    toastViewBtn.addEventListener("click", () => {
      hideIncomingEmailToast();
      openModal("emailInboxSimulatorModal");
    });
  }

  const closeToastBtn = document.getElementById("closeIncomingToastBtn");
  if (closeToastBtn) {
    closeToastBtn.addEventListener("click", hideIncomingEmailToast);
  }

  // Botones de Entrada a la Sala / Lobby y Sala Privada (Petición de Entrada al Anfitrión)
  const btnEnterLive = document.getElementById("btnEnterLiveRoom");
  if (btnEnterLive) {
    btnEnterLive.addEventListener("click", requestStageJoin);
  }

  const btnStayPrivate = document.getElementById("btnStayPrivateRoom");
  if (btnStayPrivate) {
    btnStayPrivate.addEventListener("click", stayInPrivateRoom);
  }

  const btnBannerEnterDyr = document.getElementById("btnBannerEnterDyr");
  if (btnBannerEnterDyr) {
    btnBannerEnterDyr.addEventListener("click", requestStageJoin);
  }

  const resendBtn = document.getElementById("resendVerificationCodeBtn");
  if (resendBtn) {
    resendBtn.addEventListener("click", resendVerificationEmail);
  }

  const changeEmailBtn = document.getElementById("changeEmailBtn");
  if (changeEmailBtn) {
    changeEmailBtn.addEventListener("click", returnToRegistrationForm);
  }

  // ===================================================================
  // LISTENERS DEL PANEL DE MODERACIÓN, MENÚ CONTEXTUAL Y DMs
  // ===================================================================
  const openAddModBtn = document.getElementById("openAddModModalBtn");
  const closeAddModBtn = document.getElementById("closeAddModModalBtn");
  const btnConfirmAddMod = document.getElementById("btnConfirmAddMod");

  if (openAddModBtn) {
    openAddModBtn.addEventListener("click", () => {
      populateModCandidatesSelect();
      openModal("addModeratorModal");
    });
  }

  if (closeAddModBtn) {
    closeAddModBtn.addEventListener("click", () => closeModal("addModeratorModal"));
  }

  if (btnConfirmAddMod) {
    btnConfirmAddMod.addEventListener("click", handleConfirmAddModerator);
  }

  // Submenú Contextual del Chat
  const closeCtxMenuBtn = document.getElementById("closeCtxMenuBtn");
  if (closeCtxMenuBtn) {
    closeCtxMenuBtn.addEventListener("click", closeChatUserContextMenu);
  }

  window.addEventListener("click", (e) => {
    const menu = document.getElementById("chatUserContextMenu");
    if (menu && menu.style.display !== "none" && !menu.contains(e.target) && !e.target.closest(".interactive-user-tag") && !e.target.closest(".chat-user-avatar")) {
      closeChatUserContextMenu();
    }
  });

  // Acciones del Submenú Contextual del Chat
  const ctxPrivateMsg = document.getElementById("ctxActionPrivateMsg");
  if (ctxPrivateMsg) {
    ctxPrivateMsg.addEventListener("click", () => {
      closeChatUserContextMenu();
      if (activeCtxUser) openPrivateChatWith(activeCtxUser);
    });
  }

  const ctxReply = document.getElementById("ctxActionReply");
  if (ctxReply) {
    ctxReply.addEventListener("click", () => {
      closeChatUserContextMenu();
      if (activeCtxUser) {
        const chatInput = document.getElementById("chatInput");
        if (chatInput) {
          chatInput.value = `${activeCtxUser.handle} `;
          chatInput.focus();
        }
      }
    });
  }

  // Mandar Regalo: Abrir catálogo completo targeting al usuario seleccionado
  const ctxSendGift = document.getElementById("ctxActionSendGift");
  if (ctxSendGift) {
    ctxSendGift.addEventListener("click", () => {
      const targetUser = activeCtxUser;
      closeChatUserContextMenu();
      if (targetUser) {
        openGiftDrawerForUser(targetUser);
      }
    });
  }

  // Regalos Rápidos en 1 Clic (Corazón, Fuego, Manopla, Rosa, Cohete)
  document.querySelectorAll(".ctx-quick-gift-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const giftId = btn.dataset.giftId;
      const targetUser = activeCtxUser;
      closeChatUserContextMenu();

      if (!targetUser) return;
      const gift = TokTokState.gifts.find(g => g.id === giftId);
      if (!gift) return;

      // Asignar el destinatario del regalo a la persona sobre la que se abrió el menú
      TokTokState.targetGiftRecipient = targetUser;
      sendGift(gift);
    });
  });

  const ctxToggleMod = document.getElementById("ctxActionToggleMod");
  if (ctxToggleMod) {
    ctxToggleMod.addEventListener("click", () => {
      closeChatUserContextMenu();
      if (!activeCtxUser) return;
      if (isUserModerator(activeCtxUser.handle) || isUserModerator(activeCtxUser.name)) {
        removeModerator(activeCtxUser.handle);
        alert(`🛡️ Se ha quitado el rol de moderador a ${activeCtxUser.name}.`);
      } else {
        addModerator({ name: activeCtxUser.name, handle: activeCtxUser.handle });
        alert(`🎉 ¡${activeCtxUser.name} ha sido nombrado Moderador Oficial!`);
      }
    });
  }

  const ctxMute = document.getElementById("ctxActionMute");
  if (ctxMute) {
    ctxMute.addEventListener("click", () => {
      closeChatUserContextMenu();
      if (!activeCtxUser) return;
      addChatMessage("🛡️ Moderación", `El micrófono de ${activeCtxUser.handle} ha sido silenciado por orden de moderación.`);
      playSoundFx("chime");
      alert(`🔇 Has silenciado el micrófono de ${activeCtxUser.name}.`);
    });
  }

  const ctxBan = document.getElementById("ctxActionBan");
  if (ctxBan) {
    ctxBan.addEventListener("click", () => {
      closeChatUserContextMenu();
      if (!activeCtxUser) return;
      if (confirm(`¿Expulsar y bloquear a ${activeCtxUser.name} (${activeCtxUser.handle}) de la sala? No podrá escribir ni participar con cámara hasta que levantes el bloqueo.`)) {
        banUser(activeCtxUser);
      }
    });
  }

  // Modal de Mensajes Privados (DM)
  const closePmBtn = document.getElementById("closePrivateMessageModalBtn");
  if (closePmBtn) {
    closePmBtn.addEventListener("click", () => closeModal("privateMessageModal"));
  }

  const dmForm = document.getElementById("dmChatForm");
  if (dmForm) {
    dmForm.addEventListener("submit", handleSendDm);
  }

  // Modal de Bandeja de Entrada (Inbox)
  const openInboxHeaderBtn = document.getElementById("openInboxModalBtn");
  if (openInboxHeaderBtn) {
    openInboxHeaderBtn.addEventListener("click", openInboxModal);
  }

  const dockOpenInboxBtn = document.getElementById("dockOpenInboxBtn");
  if (dockOpenInboxBtn) {
    dockOpenInboxBtn.addEventListener("click", openInboxModal);
  }

  const closeInboxModalBtnEl = document.getElementById("closeInboxModalBtn");
  if (closeInboxModalBtnEl) {
    closeInboxModalBtnEl.addEventListener("click", () => closeModal("inboxModal"));
  }

  const btnBackToInbox = document.getElementById("btnBackToInboxFromDm");
  if (btnBackToInbox) {
    btnBackToInbox.addEventListener("click", () => {
      closeModal("privateMessageModal");
      openInboxModal();
    });
  }

  const inboxSearchInp = document.getElementById("inboxSearchInput");
  if (inboxSearchInp) {
    inboxSearchInp.addEventListener("input", (e) => {
      renderInboxThreads(e.target.value.trim());
    });
  }
}

function populateModCandidatesSelect() {
  const select = document.getElementById("selectModCandidate");
  if (!select) return;
  select.innerHTML = "";

  const available = TokTokState.registeredUsers.filter(u => !isUserModerator(u.handle));
  if (available.length === 0) {
    select.innerHTML = `<option value="">Todos los usuarios ya son moderadores</option>`;
    return;
  }

  select.innerHTML = available.map(u => `
    <option value="${u.id}">${u.name} (${u.handle}) - ${u.bio || 'Registrado'}</option>
  `).join("");
}

function handleConfirmAddModerator() {
  const select = document.getElementById("selectModCandidate");
  const customInput = document.getElementById("customModInput");

  let selectedUser = null;
  const customVal = customInput ? customInput.value.trim() : "";

  if (customVal) {
    selectedUser = {
      name: customVal.replace('@', ''),
      handle: customVal.startsWith('@') ? customVal : `@${customVal}`
    };
  } else if (select && select.value) {
    selectedUser = TokTokState.registeredUsers.find(u => u.id === select.value);
  }

  if (!selectedUser) {
    alert("⚠️ Por favor selecciona un usuario o escribe su nombre/usuario.");
    return;
  }

  addModerator(selectedUser);
  closeModal("addModeratorModal");
  if (customInput) customInput.value = "";
  alert(`🎉 ¡${selectedUser.name} ha sido nombrado Moderador Oficial con éxito!`);
}

// Registro de Service Worker PWA
let deferredPwaPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.deferredPwaPrompt = e;
  const triggerInstallBtn = document.getElementById("triggerPwaInstallBtn");
  if (triggerInstallBtn) {
    triggerInstallBtn.textContent = "📲 Instalar Tok Tok Ahora en este Móvil";
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch((err) => console.log("Service Worker no registrado:", err));
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!window._swReloaded) {
      window._swReloaded = true;
      window.location.reload();
    }
  });
}

function applyCameraFilter(filterName) {
  const video = document.getElementById("localUserVideo");
  const canvas = document.getElementById("localUserCanvas");
  const filterClasses = ["filter-glow", "filter-cyberpunk", "filter-retro", "filter-golden", "filter-bw"];
  
  [video, canvas].forEach(el => {
    if (!el) return;
    filterClasses.forEach(c => el.classList.remove(c));
    if (filterName !== "none") el.classList.add(`filter-${filterName}`);
  });
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add("show");
}

function closeModal(id) {
  if ((id === "mandatoryRegisterModal" || id === "emailVerificationModal") && !isUserRegistered()) {
    // Bloquear cierre de modales de registro hasta que se active la cuenta
    return;
  }
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove("show");
}

let pendingVerificationState = {
  name: "",
  handle: "",
  email: "",
  bio: "",
  avatarBg: "#fe2c55",
  pinCode: "",
  timestamp: 0
};

function hideIncomingEmailToast() {
  const toast = document.getElementById("incomingEmailToast");
  if (toast) {
    toast.classList.remove("show");
    setTimeout(() => {
      if (!toast.classList.contains("show")) {
        toast.style.display = "none";
      }
    }, 350);
  }
}

function checkRoomEntrance() {
  const isCreator = TokTokState.localUser.isHost || TokTokState.localUser.isCreator;
  if (isCreator) {
    TokTokState.isJoinedRoom = true;
    const overlay = document.getElementById("roomEntranceOverlay");
    if (overlay) overlay.style.display = "none";
    const banner = document.getElementById("privateRoomBanner");
    if (banner) banner.style.display = "none";
  } else {
    if (!isUserRegistered()) {
      TokTokState.isJoinedRoom = false;
      return;
    }
    if (!TokTokState.isJoinedRoom) {
      showRoomEntranceOverlay();
    }
  }
}

function showRoomEntranceOverlay() {
  TokTokState.isJoinedRoom = false;
  const overlay = document.getElementById("roomEntranceOverlay");
  if (overlay) overlay.style.display = "flex";
  const banner = document.getElementById("privateRoomBanner");
  if (banner) banner.style.display = "none";
}

function enterLiveRoom() {
  unlockAudioContexts();
  TokTokState.isJoinedRoom = true;
  const overlay = document.getElementById("roomEntranceOverlay");
  if (overlay) overlay.style.display = "none";
  const banner = document.getElementById("privateRoomBanner");
  if (banner) banner.style.display = "none";

  addChatMessage("TokTokBot", `👋 Te has unido a la sala en vivo de DYR.`);
  playSoundFx("join");
  sendPresenceHeartbeat();
}

function requestStageJoin() {
  const isCreator = TokTokState.localUser.isHost || TokTokState.localUser.isCreator;
  if (isCreator) {
    enterLiveRoom();
    return;
  }

  // Si ya está dentro del escenario
  if (isUserOnStage()) {
    TokTokState.isJoinedRoom = true;
    const overlay = document.getElementById("roomEntranceOverlay");
    if (overlay) overlay.style.display = "none";
    const banner = document.getElementById("privateRoomBanner");
    if (banner) banner.style.display = "none";
    return;
  }

  // Actualizar UI del botón para mostrar estado de espera
  const btnEnterLive = document.getElementById("btnEnterLiveRoom");
  if (btnEnterLive) {
    btnEnterLive.disabled = true;
    btnEnterLive.innerHTML = "⏳ Solicitud enviada a David. Esperando aprobación...";
    btnEnterLive.style.opacity = "0.85";
  }

  const notice = document.querySelector(".entrance-notice");
  if (notice) {
    notice.innerHTML = "⏳ <strong>Solicitud de entrada enviada a DYR.</strong><br>En cuanto David pulse 'Aceptar' en su teléfono, subirás directamente al escenario con cámara y audio en directo.";
  }

  const reqPayload = {
    userId: TokTokState.localUser.id,
    name: TokTokState.localUser.name,
    handle: TokTokState.localUser.handle,
    email: TokTokState.localUser.email,
    avatarBg: TokTokState.localUser.avatarBg,
    timestamp: Date.now()
  };

  // Enviar por WebSocket
  if (realtimeSocket && realtimeSocket.readyState === 1) {
    try {
      realtimeSocket.send(JSON.stringify({ type: "stage_join_request", data: reqPayload }));
    } catch (_) {}
  }

  // Enviar por API REST
  fetch("/api/stage/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqPayload)
  }).catch(() => {});

  playSoundFx("chime");
  alert("⏳ Solicitud enviada a David.\n\nEn cuanto David acepte tu entrada en su pantalla, subirás automáticamente al escenario.");
}

function handleIncomingStageJoinRequest(reqData) {
  if (!TokTokState.localUser.isHost && !TokTokState.localUser.isCreator) return;
  if (TokTokState.guestsOnStage.some(g => g && g.id === reqData.userId)) return;

  const banner = document.getElementById("incomingRequestBanner");
  const avatarEl = document.getElementById("reqAvatar");
  const usernameEl = document.getElementById("reqUsername");
  const actionText = document.querySelector(".req-action-text");
  const acceptBtn = document.getElementById("acceptIncomingReqBtn");
  const rejectBtn = document.getElementById("rejectIncomingReqBtn");

  if (!banner) return;

  if (avatarEl) {
    avatarEl.textContent = (reqData.name || "US").substring(0, 2).toUpperCase();
    avatarEl.style.background = reqData.avatarBg || "#fe2c55";
  }
  if (usernameEl) {
    usernameEl.textContent = `${reqData.name} (${reqData.handle || '@invitado'})`;
  }
  if (actionText) {
    actionText.innerHTML = `🙋 <strong>¡Se quiere unir a tu directo!</strong><br>¿Aceptas que suba al escenario con cámara y micrófono?`;
  }

  banner.style.display = "block";
  requestAnimationFrame(() => banner.classList.add("show"));
  playSoundFx("fanfare");

  // Clonar botones para asegurar manejadores frescos
  const newAccept = acceptBtn.cloneNode(true);
  const newReject = rejectBtn.cloneNode(true);
  acceptBtn.parentNode.replaceChild(newAccept, acceptBtn);
  rejectBtn.parentNode.replaceChild(newReject, rejectBtn);

  newAccept.textContent = "✅ Aceptar Entrada";
  newReject.textContent = "❌ Rechazar";

  newAccept.onclick = () => {
    banner.classList.remove("show");
    banner.style.display = "none";
    const approvePayload = {
      userId: reqData.userId,
      name: reqData.name,
      handle: reqData.handle,
      avatarBg: reqData.avatarBg
    };
    if (realtimeSocket && realtimeSocket.readyState === 1) {
      try { realtimeSocket.send(JSON.stringify({ type: "stage_join_approve", data: approvePayload })); } catch (_) {}
    }
    fetch("/api/stage/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approvePayload)
    }).then(res => res.json()).then(data => {
      if (data && data.stageSeats) syncStageSeats(data.stageSeats);
    }).catch(() => {});
  };

  newReject.onclick = () => {
    banner.classList.remove("show");
    banner.style.display = "none";
    const rejectPayload = { userId: reqData.userId };
    if (realtimeSocket && realtimeSocket.readyState === 1) {
      try { realtimeSocket.send(JSON.stringify({ type: "stage_join_reject", data: rejectPayload })); } catch (_) {}
    }
    fetch("/api/stage/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rejectPayload)
    }).catch(() => {});
  };
}

function handleStageJoinAccepted(data) {
  const myId = String(TokTokState.localUser.id || "");
  const myHandle = String(TokTokState.localUser.handle || "").toLowerCase().replace('@', '').trim();
  const myName = String(TokTokState.localUser.name || "").toLowerCase().trim();

  const tId = String(data.targetUserId || "");
  const tHandle = String(data.handle || "").toLowerCase().replace('@', '').trim();
  const tName = String(data.name || "").toLowerCase().trim();

  const isMe = (tId && tId === myId) ||
               (tHandle && (tHandle === myHandle || myHandle.includes(tHandle) || tHandle.includes(myHandle))) ||
               (tName && (tName === myName || myName.includes(tName) || tName.includes(myName)));

  if (!isMe) return;

  // 1. Cerrar overlay de lobby y banner privado
  const overlay = document.getElementById("roomEntranceOverlay");
  if (overlay) overlay.style.display = "none";
  const banner = document.getElementById("privateRoomBanner");
  if (banner) banner.style.display = "none";
  TokTokState.isJoinedRoom = true;

  // 2. Desbloquear audio del navegador
  unlockAudioContexts();

  // 3. Activar cámara local y micrófono para subir al escenario
  setupLocalCamera().then((activeStream) => {
    TokTokState.localUser.cameraOn = true;
    TokTokState.localUser.micOn = true;
    startLiveAudioCapture(activeStream || TokTokState.localUser.mediaStream);
    playSoundFx("fanfare");
    addChatMessage("TokTokBot", `🎉 ¡David ha aceptado tu solicitud! Ya estás en el escenario en vivo.`);
    alert(`🎉 ¡El Anfitrión ha aceptado tu entrada!\n\nHas subido al escenario en el Asiento #${(data.seatIndex || 0) + 1}.\nTu cámara y audio están transmitiendo.`);
    syncWebRTCVideoAudioPeers();
  }).catch(() => {
    TokTokState.localUser.micOn = true;
    startLiveAudioCapture();
    playSoundFx("fanfare");
    alert(`🎉 ¡El Anfitrión ha aceptado tu entrada!\nHas subido al escenario en el Asiento #${(data.seatIndex || 0) + 1}.`);
  });
}

function handleStageJoinRejected(data) {
  const myId = String(TokTokState.localUser.id || "");
  if (data.targetUserId === myId) {
    const btnEnterLive = document.getElementById("btnEnterLiveRoom");
    if (btnEnterLive) {
      btnEnterLive.disabled = false;
      btnEnterLive.innerHTML = "🔴 Volver a Solicitar Entrada";
      btnEnterLive.style.opacity = "1";
    }
    const notice = document.querySelector(".entrance-notice");
    if (notice) {
      notice.innerHTML = "❌ El anfitrión no ha podido aceptar tu entrada al escenario en este momento.";
    }
    alert("El anfitrión no ha podido aceptar tu entrada al escenario en este momento.");
  }
}

function stayInPrivateRoom() {
  TokTokState.isJoinedRoom = false;
  const overlay = document.getElementById("roomEntranceOverlay");
  if (overlay) overlay.style.display = "none";
  const banner = document.getElementById("privateRoomBanner");
  if (banner) banner.style.display = "flex";

  alert("🔒 Estás en tu Sala Privada.\nEl audio y el vídeo del directo de DYR están silenciados.\nPuedes unirte al directo cuando quieras pulsando el botón superior.");
}

function leaveLiveRoomToLobby() {
  if (TokTokState.localUser.mediaStream) {
    try { TokTokState.localUser.mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    TokTokState.localUser.mediaStream = null;
  }
  TokTokState.localUser.cameraOn = false;
  TokTokState.localUser.micOn = false;

  TokTokState.isJoinedRoom = false;
  showRoomEntranceOverlay();
}

function checkMandatoryRegistration() {
  if (!isUserRegistered()) {
    TokTokState.isJoinedRoom = false;
    openModal("mandatoryRegisterModal");
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !isUserRegistered()) {
        e.preventDefault();
        if (pendingVerificationState.pinCode) {
          openModal("emailVerificationModal");
        } else {
          openModal("mandatoryRegisterModal");
        }
      }
    });
  } else {
    hideIncomingEmailToast();
    checkRoomEntrance();
  }
}

function handleMandatoryRegistration(e) {
  e.preventDefault();
  const errorBox = document.getElementById("mandRegError");
  if (errorBox) {
    errorBox.style.display = "none";
    errorBox.textContent = "";
  }

  const nameInput = document.getElementById("mandRegName");
  const emailInput = document.getElementById("mandRegEmail");
  const handleInput = document.getElementById("mandRegHandle");
  const bioInput = document.getElementById("mandRegBio");
  const termsCheckbox = document.getElementById("mandRegTerms");
  const selectedColor = document.querySelector("input[name='mandAvatarColor']:checked")?.value || "#fe2c55";

  const name = nameInput ? nameInput.value.trim() : "";
  const email = emailInput ? emailInput.value.trim() : "";
  let handle = handleInput ? handleInput.value.trim().replace(/^@/, "") : "";
  const bio = bioInput ? bioInput.value.trim() : "";

  const showError = (msg) => {
    if (errorBox) {
      errorBox.innerHTML = `⚠️ ${msg}`;
      errorBox.style.display = "flex";
      errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      alert(msg);
    }
  };

  // 1. Validar nombre
  if (!name || name.length < 2) {
    return showError("Debes introducir tu nombre o nombre artístico (mínimo 2 letras).");
  }

  // 2. Validar correo obligatorio y sintaxis
  if (!email) {
    return showError("El correo electrónico es OBLIGATORIO para registrarte.");
  }
  if (!isValidEmail(email)) {
    return showError("El formato del correo electrónico NO es válido. Debe ser una dirección real con dominio (ejemplo: usuario@correo.com o tunombre@dominio.es).");
  }

  // 3. Validar handle
  if (!handle || handle.length < 2) {
    return showError("Debes indicar un nombre de usuario (@) de al menos 2 caracteres.");
  }

  // 4. Filtro estricto contra palabras soeces o insultos
  if (containsProfanity(name) || containsProfanity(handle) || containsProfanity(email) || containsProfanity(bio)) {
    return showError("🚫 REGISTRO DENEGADO: Se detectó lenguaje soez o insultos en tus datos. Las normas de la comunidad prohíben totalmente palabras vulgares.");
  }

  // Regla de seguridad: Si introduce el correo del creador, redirigir a Iniciar Sesión
  if (email.toLowerCase().trim() === "davidyrosa1979@gmail.com") {
    switchAuthTab("login");
    const loginInp = document.getElementById("loginEmailInput");
    if (loginInp) loginInp.value = email;
    return showError("Este correo pertenece al Creador Oficial (DYR). Por favor, entra por la pestaña 'Iniciar Sesión'.");
  }

  // Regla de seguridad: Nadie puede registrarse con el nombre o usuario DYR
  if (name.toUpperCase().trim() === "DYR" || handle.toLowerCase().trim() === "dyr") {
    return showError("El nombre y usuario 'DYR' están reservados exclusivamente para el Creador Oficial.");
  }

  // 5. Validar aceptación de términos
  if (!termsCheckbox || !termsCheckbox.checked) {
    return showError("Debes marcar la casilla aceptando las normas de la comunidad y certificando que tu correo es válido.");
  }

  // Generar código de verificación aleatorio de 6 dígitos
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  pendingVerificationState = {
    name: name,
    handle: handle,
    email: email.toLowerCase(),
    bio: bio || "Usuario registrado en TokRoom 🌟",
    avatarBg: selectedColor,
    pinCode: pin,
    timestamp: Date.now()
  };

  // Actualizar UI del Modal de Verificación y Simulador de Buzón
  const targetEmailDisplay = document.getElementById("verifyTargetEmailDisplay");
  if (targetEmailDisplay) targetEmailDisplay.textContent = pendingVerificationState.email;

  const inboxRecipientDisplay = document.getElementById("inboxRecipientDisplay");
  if (inboxRecipientDisplay) inboxRecipientDisplay.textContent = `para: ${pendingVerificationState.email}`;

  const inboxEmailCodeDisplay = document.getElementById("inboxEmailCodeDisplay");
  if (inboxEmailCodeDisplay) inboxEmailCodeDisplay.textContent = pin;

  const emailGreetingName = document.getElementById("emailGreetingName");
  if (emailGreetingName) emailGreetingName.textContent = `¡Hola, ${name}!`;

  const pinInput = document.getElementById("verifyPinInput");
  if (pinInput) {
    pinInput.value = "";
    setTimeout(() => pinInput.focus(), 300);
  }

  // Cerrar registro paso 1 y abrir verificación paso 2
  const regModal = document.getElementById("mandatoryRegisterModal");
  if (regModal) regModal.classList.remove("show");

  openModal("emailVerificationModal");
  playSoundFx("chime");

  // Mostrar notificación flotante de correo entrante
  showIncomingEmailToast(pin);
}

function showIncomingEmailToast(pin) {
  if (isUserRegistered()) return;
  const toast = document.getElementById("incomingEmailToast");
  const subject = document.getElementById("incomingToastSubject");
  if (!toast) return;

  toast.style.display = "flex";
  if (subject) subject.textContent = `Tu código de activación es: ${pin}`;
  void toast.offsetWidth;
  toast.classList.add("show");

  clearTimeout(window._incomingToastTimer);
  window._incomingToastTimer = setTimeout(() => {
    hideIncomingEmailToast();
  }, 4000);
}

function handleVerificationCodeSubmit(e) {
  e.preventDefault();
  const errorBox = document.getElementById("verifyCodeError");
  if (errorBox) {
    errorBox.style.display = "none";
    errorBox.textContent = "";
  }

  const pinInput = document.getElementById("verifyPinInput");
  const enteredCode = pinInput ? pinInput.value.trim().replace(/\s+/g, "") : "";

  if (!enteredCode || enteredCode.length !== 6) {
    if (errorBox) {
      errorBox.innerHTML = "⚠️ Debes ingresar el código completo de 6 dígitos enviado a tu correo.";
      errorBox.style.display = "flex";
    }
    return;
  }

  if (enteredCode === pendingVerificationState.pinCode) {
    activateAccount(pendingVerificationState);
  } else {
    if (errorBox) {
      errorBox.innerHTML = "❌ Código incorrecto. Revisa tu buzón o pulsa 'Entrar a Mi Bandeja de Correo' para ver el código exacto.";
      errorBox.style.display = "flex";
    }
  }
}

function activateAccount(state) {
  const isCreatorEmail = (state.email && state.email.toLowerCase().trim() === "davidyrosa1979@gmail.com");
  const isVip = isCreatorEmail || isVipInfiniteUser(state);
  const isRosa = !isCreatorEmail && isVip;
  const assignedId = isCreatorEmail ? "user_dyr_creator" : (isRosa ? "user_rosa_guest" : (state.id || `user_${Date.now()}`));

  const newProfile = {
    id: assignedId,
    name: state.name,
    handle: state.handle,
    email: state.email,
    bio: state.bio,
    avatarBg: state.avatarBg,
    isEmailVerified: true,
    isCreator: isCreatorEmail,
    isHost: isCreatorEmail,
    hasInfiniteCoins: isVip,
    registeredAt: new Date().toISOString()
  };

  if (isCreatorEmail) {
    TokTokState.localUser.isHost = true;
    TokTokState.localUser.isCreator = true;
    TokTokState.localUser.hasInfiniteCoins = true;
    TokTokState.room.userCoins = 999999999;
  } else if (isVip) {
    TokTokState.localUser.isHost = false;
    TokTokState.localUser.isCreator = false;
    TokTokState.localUser.hasInfiniteCoins = true;
    TokTokState.room.userCoins = 999999999;
  } else {
    TokTokState.localUser.isHost = false;
    TokTokState.localUser.isCreator = false;
    TokTokState.localUser.hasInfiniteCoins = false;
    TokTokState.room.userCoins = 1000;
    localStorage.setItem("toktok_user_coins", "1000");
  }

  localStorage.setItem(STORAGE_KEY_REGISTERED, "true");
  localStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify(newProfile));

  TokTokState.localUser.id = newProfile.id;
  TokTokState.localUser.name = newProfile.name;
  TokTokState.localUser.handle = newProfile.handle;
  TokTokState.localUser.email = newProfile.email;
  TokTokState.localUser.avatarBg = newProfile.avatarBg;

  // Añadirlo al directorio de la comunidad
  TokTokState.registeredUsers.unshift({
    id: newProfile.id,
    name: newProfile.name,
    email: newProfile.email,
    handle: `@${newProfile.handle}`,
    avatarBg: newProfile.avatarBg,
    bio: newProfile.bio,
    status: "online",
    colorHue: 335
  });
  saveRegisteredUsers();
  renderRegisteredUsersDirectory();
  updateModeratorAccessUI();

  // Sincronizar permanentemente con el servidor central
  fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: newProfile.id,
      name: newProfile.name,
      handle: newProfile.handle,
      email: newProfile.email,
      bio: newProfile.bio,
      avatarBg: newProfile.avatarBg
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data && data.ok) {
      loadRegisteredUsers();
    }
  })
  .catch(err => console.error("Error sincronizando registro con servidor:", err));

  updateProfileHeaderUI();
  updateCoinsDisplay();
  renderVideoGrid();

  // Cerrar modales de verificación
  const verifyModal = document.getElementById("emailVerificationModal");
  if (verifyModal) verifyModal.classList.remove("show");

  const inboxModal = document.getElementById("emailInboxSimulatorModal");
  if (inboxModal) inboxModal.classList.remove("show");

  hideIncomingEmailToast();

  if (isCreatorEmail) {
    TokTokState.isJoinedRoom = true;
    playSoundFx("fanfare");
    addChatMessage("TokTokBot", `👑 ¡Bienvenido DYR! Tu sala oficial en vivo está activa con control total y monedas infinitas.`);
    alert(`👑 ¡Bienvenido DYR!\nHas iniciado sesión como Creador Oficial con Monedas Infinitas.`);
  } else {
    showRoomEntranceOverlay();
    playSoundFx("fanfare");
    addChatMessage("TokTokBot", `🎉 ¡Bienvenido a Tok Tok, ${newProfile.name}! Tu cuenta está verificada.`);
    alert(`🎉 ¡Cuenta Verificada con Éxito!\n\nBienvenido ${newProfile.name}.\nPulsa '🔴 Entrar a la Sala en Vivo' para solicitar subir al directo.`);
  }
}

function resendVerificationEmail() {
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  pendingVerificationState.pinCode = pin;

  const inboxEmailCodeDisplay = document.getElementById("inboxEmailCodeDisplay");
  if (inboxEmailCodeDisplay) inboxEmailCodeDisplay.textContent = pin;

  const errorBox = document.getElementById("verifyCodeError");
  if (errorBox) {
    errorBox.style.display = "none";
  }

  playSoundFx("chime");
  showIncomingEmailToast(pin);
  alert(`✉️ Se ha reenviado un nuevo correo de verificación a ${pendingVerificationState.email}.\nTu nuevo código es: ${pin}`);
}

function returnToRegistrationForm() {
  const verifyModal = document.getElementById("emailVerificationModal");
  if (verifyModal) verifyModal.classList.remove("show");

  openModal("mandatoryRegisterModal");
}

// Controlador de la barra de navegación segmentada móvil
function setupMobileViewNavigation() {
  const bar = document.getElementById("mobileSegmentedBar");
  const stageContainer = document.getElementById("mainStageContainer");
  if (!bar || !stageContainer) return;

  bar.querySelectorAll(".mob-seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      bar.querySelectorAll(".mob-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const view = btn.dataset.view;
      stageContainer.setAttribute("data-active-view", view);

      if (view === "chat") {
        const chatTab = document.querySelector(".sidebar-tab[data-tab='chat']");
        if (chatTab) chatTab.click();
      } else if (view === "guests") {
        const guestsTab = document.querySelector(".sidebar-tab[data-tab='guests']");
        if (guestsTab) guestsTab.click();
      }
    });
  });

  // Estado inicial móvil: Escenario
  stageContainer.setAttribute("data-active-view", "stage");
}

// ===================================================================
// MOTOR DE SINCRONIZACIÓN EN TIEMPO REAL (WEBSOCKET + POLLING FAILSAFE)
// INDESTRUCTIBLE FRENTE A CORTES DE CLOUDFLARE Y NAVEGADORES MÓVILES
// ===================================================================
let realtimeSocket = null;
let sseSource = null;
let lastSyncTimestamp = 0;
const seenChatIds = new Set();
let frameStreamInterval = null;

function initRealtimeSync() {
  connectWebSocket();
  initSseFallback();

  // Failsafe HTTP Polling cada 1 segundo (garantiza entrega de chat y WebRTC al 100%)
  pollSync();
  setInterval(pollSync, 1000);

  // Polling automático de mensajes privados cada 3 segundos para actualización inmediata del Buzón
  loadDmInbox();
  setInterval(loadDmInbox, 3000);

  // Heartbeat de presencia cada 2.5 segundos
  sendPresenceHeartbeat();
  setInterval(sendPresenceHeartbeat, 2500);

  // Ganancia continua de monedas por tiempo de conexión para usuarios estándar (los VIPs tienen infinitas)
  setInterval(() => {
    if (!isVipInfiniteUser(TokTokState.localUser) && TokTokState.isJoinedRoom) {
      TokTokState.room.userCoins = (TokTokState.room.userCoins || 0) + 10;
      localStorage.setItem("toktok_user_coins", TokTokState.room.userCoins.toString());
      updateCoinsDisplay();
    }
  }, 30000); // +10 monedas cada 30 segundos
}

function connectWebSocket() {
  try {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const currentRoomId = TokTokState.roomId || "main";
    const wsUrl = `${proto}//${window.location.host}/?room=${encodeURIComponent(currentRoomId)}`;
    const ws = new WebSocket(wsUrl);
    realtimeSocket = ws;

    // Interceptor para asegurar que todo mensaje emitido lleve el roomId de la sala activa
    const originalSend = ws.send.bind(ws);
    ws.send = function(data) {
      try {
        if (typeof data === "string") {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === "object" && !parsed.roomId) {
            parsed.roomId = TokTokState.roomId || "main";
            data = JSON.stringify(parsed);
          }
        }
      } catch (_) {}
      return originalSend(data);
    };

    ws.onopen = () => {
      console.log("🟢 WebSocket conectado en sala:", currentRoomId);
      ws.send(JSON.stringify({
        type: "join_room",
        roomId: currentRoomId,
        user: TokTokState.localUser
      }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload) return;
        if (payload.type === "init" && payload.data) {
          if (payload.data.roomName) updateRoomNameUI(payload.data.roomName);
          if (payload.data.stageSeats) syncStageSeats(payload.data.stageSeats);
          if (payload.data.onlineUsers) syncOnlineUsers(payload.data.onlineUsers);
          return;
        }
        handleRealtimeEvent(payload.type, payload.data);
      } catch (err) {
        console.warn("Error procesando mensaje WebSocket:", err);
      }
    };

    ws.onclose = () => {
      setTimeout(connectWebSocket, 1500);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (err) {
    setTimeout(connectWebSocket, 3000);
  }
}

function initSseFallback() {
  try {
    if (sseSource) sseSource.close();
    const currentRoomId = TokTokState.roomId || "main";
    sseSource = new EventSource(`/api/events?room=${encodeURIComponent(currentRoomId)}`);

    sseSource.addEventListener("chat_message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleRealtimeEvent("chat_message", msg);
      } catch (_) {}
    });

    sseSource.addEventListener("webrtc_signal", (e) => {
      try {
        const sig = JSON.parse(e.data);
        handleRealtimeEvent("webrtc_signal", sig);
      } catch (_) {}
    });

    sseSource.addEventListener("stage_invite", (e) => {
      try {
        const inv = JSON.parse(e.data);
        handleRealtimeEvent("stage_invite", inv);
      } catch (_) {}
    });

    sseSource.addEventListener("stage_update", (e) => {
      try {
        const st = JSON.parse(e.data);
        handleRealtimeEvent("stage_update", st);
      } catch (_) {}
    });

    sseSource.addEventListener("user_banned", (e) => {
      try {
        const ban = JSON.parse(e.data);
        handleRealtimeEvent("user_banned", ban);
      } catch (_) {}
    });

    sseSource.addEventListener("user_deleted", (e) => {
      try {
        const del = JSON.parse(e.data);
        handleRealtimeEvent("user_deleted", del);
      } catch (_) {}
    });

    sseSource.addEventListener("camera_frame", (e) => {
      try {
        const frame = JSON.parse(e.data);
        handleRealtimeEvent("camera_frame", frame);
      } catch (_) {}
    });

    sseSource.addEventListener("audio_chunk", (e) => {
      try {
        const chunk = JSON.parse(e.data);
        handleRealtimeEvent("audio_chunk", chunk);
      } catch (_) {}
    });

    sseSource.addEventListener("room_closed", (e) => {
      try {
        const d = JSON.parse(e.data);
        handleRealtimeEvent("room_closed", d);
      } catch (_) {}
    });

    sseSource.addEventListener("room_reset", (e) => {
      try {
        const d = JSON.parse(e.data);
        handleRealtimeEvent("room_reset", d);
      } catch (_) {}
    });

    sseSource.addEventListener("dm_received", (e) => {
      try {
        const d = JSON.parse(e.data);
        handleRealtimeEvent("dm_received", d);
      } catch (_) {}
    });
  } catch (_) {}
}

// Despachador centralizado de eventos en tiempo real
function handleRealtimeEvent(type, data) {
  if (!data) return;

  if (type === "chat_message") {
    if (data.senderId !== TokTokState.localUser.id) {
      const key = `${data.senderId}_${data.messageText}_${data.timestamp || ''}`;
      if (!seenChatIds.has(key)) {
        seenChatIds.add(key);
        addChatMessage(data.userName, data.messageText, data.isGift || false);
      }
    }
  } else if (type === "webrtc_signal") {
    handleWebRTCSignal(data);
  } else if (type === "camera_frame") {
    handleIncomingCameraFrame(data);
  } else if (type === "audio_chunk") {
    handleIncomingAudioChunk(data);
  } else if (type === "moderator_add" && data && data.moderator) {
    if (!isUserModerator(data.moderator.handle) && !isUserModerator(data.moderator.name)) {
      TokTokState.moderation.moderators.push(data.moderator);
      renderModeratorsList();
      renderVideoGrid();
      updateModeratorAccessUI();
    }
  } else if (type === "moderator_remove" && data && data.target) {
    const t = String(data.target).toLowerCase().replace('@', '').trim();
    const idx = TokTokState.moderation.moderators.findIndex(m => 
      (m.id && m.id.toLowerCase() === t) ||
      (m.name && m.name.toLowerCase() === t) ||
      (m.handle && m.handle.toLowerCase().replace('@', '') === t)
    );
    if (idx !== -1) {
      TokTokState.moderation.moderators.splice(idx, 1);
      renderModeratorsList();
      renderVideoGrid();
      updateModeratorAccessUI();
    }
  } else if (type === "stage_update") {
    if (data.stageSeats) syncStageSeats(data.stageSeats);
  } else if (type === "presence_update") {
    if (data.onlineUsers) syncOnlineUsers(data.onlineUsers);
  } else if (type === "stage_invite") {
    const myId = String(TokTokState.localUser.id || "");
    const myHandle = String(TokTokState.localUser.handle || "").toLowerCase().replace('@', '').trim();
    const myName = String(TokTokState.localUser.name || "").toLowerCase().trim();

    const tId = String(data.targetUserId || "");
    const tHandle = String(data.targetHandle || "").toLowerCase().replace('@', '').trim();
    const tName = String(data.targetName || "").toLowerCase().trim();

    const isMe = (tId && tId === myId) ||
                 (tHandle && (tHandle === myHandle || myHandle.includes(tHandle) || tHandle.includes(myHandle))) ||
                 (tName && (tName === myName || myName.includes(tName) || tName.includes(myName)));

    if (isMe) {
      handleIncomingStageInvite(data);
    }
  } else if (type === "user_banned" || type === "user_deleted") {
    const myId = String(TokTokState.localUser.id || "");
    const myHandle = String(TokTokState.localUser.handle || "").toLowerCase().replace('@', '').trim();
    const isMe = (data.userId && data.userId === myId) || 
                 (data.handle && data.handle.toLowerCase().replace('@', '').trim() === myHandle);

    if (isMe) {
      localStorage.removeItem(STORAGE_KEY_REGISTERED);
      localStorage.removeItem(STORAGE_KEY_PROFILE);
      showBannedScreenOverlay();
    } else {
      TokTokState.guestsOnStage = TokTokState.guestsOnStage.filter(g => 
        !(g.id === data.userId || (data.handle && g.handle && g.handle.toLowerCase().includes(data.handle.toLowerCase())))
      );
      TokTokState.registeredUsers = TokTokState.registeredUsers.filter(u => 
        !(u.id === data.userId || (data.handle && u.handle && u.handle.toLowerCase().includes(data.handle.toLowerCase())))
      );
      renderVideoGrid();
      renderRegisteredUsersDirectory();
      renderStageGuestsListTab();
      renderHostControlModal();
    }
  } else if (type === "user_unbanned") {
    const myId = String(TokTokState.localUser.id || "");
    const myHandle = String(TokTokState.localUser.handle || "").toLowerCase().replace('@', '').trim();
    const myEmail = String(TokTokState.localUser.email || "").toLowerCase().trim();

    const targetId = String(data.userId || "");
    const targetHandle = String(data.handle || "").toLowerCase().replace('@', '').trim();
    const targetEmail = String(data.email || "").toLowerCase().trim();

    const isMe = (targetId && targetId === myId) ||
                 (targetHandle && (targetHandle === myHandle || myHandle.includes(targetHandle))) ||
                 (targetEmail && myEmail && targetEmail === myEmail);

    if (isMe) {
      hideBannedScreenOverlay();
      alert("🎉 ¡Tu cuenta ha sido DESBLOQUEADA por el Anfitrión!\n\nYa puedes volver a entrar y disfrutar de la aplicación.");
      setTimeout(() => window.location.reload(), 1500);
    }

    renderHostControlModal();
    renderExpelledUsersList();
  } else if (type === "stage_join_request") {
    handleIncomingStageJoinRequest(data);
  } else if (type === "stage_join_accepted") {
    handleStageJoinAccepted(data);
  } else if (type === "stage_join_rejected") {
    handleStageJoinRejected(data);
  } else if (type === "gift_sent") {
    const myId = String(TokTokState.localUser.id || "");
    const myHandle = String(TokTokState.localUser.handle || "").toLowerCase().replace('@', '').trim();
    const myName = String(TokTokState.localUser.name || "").toLowerCase().trim();

    const tId = String(data.targetUserId || "");
    const tHandle = String(data.targetHandle || "").toLowerCase().replace('@', '').trim();
    const tName = String(data.targetUserName || "").toLowerCase().trim();

    const isMeRecipient = (tId && tId === myId) ||
      (tHandle && (tHandle === myHandle || myHandle.includes(tHandle) || tHandle.includes(myHandle))) ||
      (tName && (tName === myName || myName.includes(tName) || tName.includes(myName)));

    if (isMeRecipient) {
      // Si el receptor no tiene monedas infinitas, sumar el importe íntegro del regalo
      if (!isVipInfiniteUser(TokTokState.localUser)) {
        TokTokState.room.userCoins = (TokTokState.room.userCoins || 0) + (data.giftCost || 0);
        localStorage.setItem("toktok_user_coins", TokTokState.room.userCoins.toString());
      }
      TokTokState.room.diamonds = (TokTokState.room.diamonds || 0) + (data.giftCost || 0);
      updateCoinsDisplay();
      updateDiamondsDisplay();
      playSoundFx("fanfare");
      showVipGiftAnnouncement(data.senderName, { name: data.giftName, icon: data.giftIcon }, data.targetUserName);
      burstHearts(window.innerWidth / 2, window.innerHeight / 2);
      alert(`🎁 ¡${data.senderName} te ha enviado un regalo en vivo!\n\n${data.giftIcon} ${data.giftName}\n¡Se han añadido +${data.giftCost} monedas a tu cuenta!`);
    } else if (data.senderId !== TokTokState.localUser.id) {
      showVipGiftAnnouncement(data.senderName, { name: data.giftName, icon: data.giftIcon }, data.targetUserName);
      playSoundFx("fanfare");
      burstHearts(window.innerWidth / 2, window.innerHeight / 2);
    }
  } else if (type === "dm_received") {
    const myId = String(TokTokState.localUser.id || "");
    const myHandle = String(TokTokState.localUser.handle || "").toLowerCase().replace(/^@/, '').trim();
    const rId = String(data.recipientId || "");
    const rHandle = String(data.recipientHandle || "").toLowerCase().replace(/^@/, '').trim();

    const isForMe = (rId && rId === myId) || (rHandle && (rHandle === myHandle || myHandle.includes(rHandle) || rHandle.includes(myHandle)));
    if (isForMe && data.senderId !== TokTokState.localUser.id) {
      const senderThreadKey = (data.senderHandle || '').toLowerCase().replace(/^@/, '');
      if (!dmConversationHistory[senderThreadKey]) dmConversationHistory[senderThreadKey] = [];
      dmConversationHistory[senderThreadKey].push({
        sender: "them",
        text: data.text,
        time: new Date(data.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });

      const pmModal = document.getElementById("privateMessageModal");
      const isChattingWithSender = pmModal && pmModal.classList.contains("show") && currentDmRecipient && (currentDmRecipient.handle || '').toLowerCase().replace(/^@/, '') === senderThreadKey;

      if (isChattingWithSender) {
        renderDmMessages(senderThreadKey);
        playSoundFx("pop");
      } else {
        showIncomingDmBanner(data.senderHandle, data.text);
      }
      loadDmInbox();
    }
  } else if (type === "room_closed") {
    if (data && (!data.roomId || data.roomId === TokTokState.roomId)) {
      alert(`📢 La sala en vivo "${data.roomName || 'actual'}" ha sido FINALIZADA y CERRADA por el anfitrión.\n\nSerás redirigido a la Sala Principal.`);
      window.location.href = window.location.pathname;
    }
  } else if (type === "room_reset") {
    if (data && (!data.roomId || data.roomId === TokTokState.roomId)) {
      addChatMessage("TokTokBot", "🔄 La sala principal ha sido reiniciada por el Creador.");
    }
  }
}

// Sincronización continua de respaldo vía HTTP Polling (1 segundo)
function pollSync() {
  const u = TokTokState.localUser;
  if (!u || !u.id) return;

  const url = `/api/sync?since=${lastSyncTimestamp}&userId=${encodeURIComponent(u.id)}&handle=${encodeURIComponent(u.handle || '')}`;
  fetch(url)
    .then(res => res.json())
    .then(data => {
      if (!data || !data.ok) return;
      if (data.now) lastSyncTimestamp = data.now;

      if (data.isBanned) {
        localStorage.removeItem(STORAGE_KEY_REGISTERED);
        localStorage.removeItem(STORAGE_KEY_PROFILE);
        showBannedScreenOverlay();
        return;
      }

      // 1. Mensajes de chat pendientes
      if (Array.isArray(data.newChats)) {
        data.newChats.forEach(m => {
          if (m.senderId !== u.id) {
            const key = `${m.senderId}_${m.messageText}_${m.timestamp || ''}`;
            if (!seenChatIds.has(key)) {
              seenChatIds.add(key);
              addChatMessage(m.userName, m.messageText, m.isGift || false);
            }
          }
        });
      }

      // 2. Señales WebRTC pendientes
      if (Array.isArray(data.userSignals)) {
        data.userSignals.forEach(sig => {
          handleWebRTCSignal(sig);
        });
      }

      // 3. Invitación pendiente garantizada
      if (data.pendingInvite) {
        const isAlreadyOnStage = TokTokState.guestsOnStage.some(g => g && g.id === u.id);
        if (!isAlreadyOnStage && !u.isHost) {
          handleIncomingStageInvite(data.pendingInvite);
        }
      }

      // 4. Peticiones de escenario pendientes para el Anfitrión (DYR)
      if (Array.isArray(data.pendingStageRequests) && data.pendingStageRequests.length > 0) {
        if (u.isHost || u.isCreator) {
          const firstReq = data.pendingStageRequests[0];
          if (!TokTokState.guestsOnStage.some(g => g && g.id === firstReq.userId)) {
            handleIncomingStageJoinRequest(firstReq);
          } else {
            const banner = document.getElementById("incomingRequestBanner");
            if (banner) {
              banner.classList.remove("show");
              banner.style.display = "none";
            }
          }
        }
      } else {
        const banner = document.getElementById("incomingRequestBanner");
        if (banner && (banner.classList.contains("show") || banner.style.display !== "none")) {
          banner.classList.remove("show");
          banner.style.display = "none";
        }
      }

      // 5. Asientos del escenario
      if (data.stageSeats) {
        syncStageSeats(data.stageSeats);
        // Si el usuario fue asignado al escenario pero aún no subió localmente
        if (!u.isHost && !TokTokState.isJoinedRoom) {
          const mySeat = data.stageSeats.find(s => s && (s.id === u.id || (s.handle && s.handle.toLowerCase().replace('@','') === (u.handle || '').toLowerCase().replace('@',''))));
          if (mySeat) {
            handleStageJoinAccepted({ targetUserId: u.id, seatIndex: mySeat.seatIndex, name: u.name, handle: u.handle });
          }
        }
      }
    })
    .catch(() => {});
}

// ===================================================================
// RELAY DE FOTOGRAMAS DE CÁMARA EN VIVO (VÍDEO GARANTIZADO ENTRE MÓVILES)
// ===================================================================
function startLocalCameraFrameRelay() {
  if (frameStreamInterval) clearInterval(frameStreamInterval);
  const hiddenCanvas = document.createElement("canvas");
  hiddenCanvas.width = 180;
  hiddenCanvas.height = 135;
  const ctx = hiddenCanvas.getContext("2d");

  frameStreamInterval = setInterval(() => {
    const isHost = TokTokState.localUser.isHost;
    const isGuestOnStage = TokTokState.guestsOnStage.some(g => g && g.id === TokTokState.localUser.id);
    if (!isHost && !isGuestOnStage) return;
    if (!TokTokState.localUser.cameraOn) return;

    // Buscar video local activo
    const localVideo = document.getElementById("localUserVideo") || document.querySelector("video[id^='localGuestVideo-']");
    if (!localVideo || localVideo.paused || localVideo.ended || !localVideo.srcObject) return;

    try {
      ctx.drawImage(localVideo, 0, 0, 180, 135);
      const jpegData = hiddenCanvas.toDataURL("image/jpeg", 0.3);

      const framePayload = {
        userId: TokTokState.localUser.id,
        frame: jpegData
      };

      if (realtimeSocket && realtimeSocket.readyState === 1) {
        realtimeSocket.send(JSON.stringify({ type: "camera_frame", data: framePayload }));
      } else {
        fetch("/api/camera/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(framePayload)
        }).catch(() => {});
      }
    } catch (_) {}
  }, 180); // ~5.5 fps optimizado: ligero, fluido en móviles y canal WebSocket 100% despejado para audio
}

function handleIncomingCameraFrame(data) {
  if (!data || !data.userId || !data.frame) return;
  if (data.userId === TokTokState.localUser.id) return;
  if (!TokTokState.isJoinedRoom) return;

  // 1. Fotograma del Anfitrión Oficial (DYR) recibido en los teléfonos de los invitados y espectadores:
  if (data.userId === "user_dyr_creator") {
    let hostImg = document.getElementById("hostLiveRelayImg");
    if (!hostImg) {
      const hostSlot = document.getElementById("seat-0");
      if (hostSlot) {
        hostImg = document.createElement("img");
        hostImg.id = "hostLiveRelayImg";
        hostImg.className = "video-media-element";
        hostImg.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 2;";
        hostSlot.appendChild(hostImg);
      }
    }
    if (hostImg) {
      hostImg.src = data.frame;
      hostImg.style.display = "block";
      const hostOff = document.getElementById("localVideoOffHolder");
      if (hostOff) hostOff.style.display = "none";
    }
    return;
  }

  // 2. Fotograma de un invitado: encontrar exactamente su asiento asignado en el escenario
  let targetSeatIndex = -1;
  if (TokTokState.stageSeats) {
    targetSeatIndex = TokTokState.stageSeats.findIndex((s, idx) => 
      idx > 0 && s && (s.id === data.userId || (s.handle && data.handle && s.handle.toLowerCase().replace('@','') === data.handle.toLowerCase().replace('@','')))
    );
  }
  if (targetSeatIndex <= 0 && TokTokState.guestsOnStage) {
    const g = TokTokState.guestsOnStage.find(item => item && (item.id === data.userId || (item.handle && data.handle && item.handle.toLowerCase().replace('@','') === data.handle.toLowerCase().replace('@',''))));
    if (g && g.seatIndex) targetSeatIndex = g.seatIndex;
  }

  if (targetSeatIndex > 0 && targetSeatIndex <= 15) {
    let guestImg = document.getElementById(`guestLiveRelayImg-${targetSeatIndex}`);
    if (!guestImg) {
      const seatSlot = document.getElementById(`seat-${targetSeatIndex}`);
      if (seatSlot) {
        guestImg = document.createElement("img");
        guestImg.id = `guestLiveRelayImg-${targetSeatIndex}`;
        guestImg.className = "video-media-element";
        guestImg.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 2;";
        seatSlot.appendChild(guestImg);
      }
    }
    if (guestImg) {
      guestImg.src = data.frame;
      guestImg.style.display = "block";
      const off = document.getElementById(`guestVideoOff-${targetSeatIndex}`);
      if (off) off.style.display = "none";
    }
  }
}

// ===================================================================
// RELAY DE AUDIO EN VIVO BIDIRECCIONAL (VOZ GARANTIZADA ENTRE MÓVILES)
// ===================================================================
// SISTEMA DE AUDIO EN TIEMPO REAL MULTI-USUARIO CON CALIDAD CRISTALINA
// ===================================================================
let liveAudioProcessor = null;
let liveAudioSource = null;
let speechHangover = 0; // Hangover VAD anti-cortes (~350ms)
const userAudioPipelines = new Map(); // userId -> { nextPlayTime, gainNode, lastSeen }
let masterAudioCompressor = null;

function getMasterCompressor(ctx) {
  if (!masterAudioCompressor || masterAudioCompressor.context !== ctx) {
    masterAudioCompressor = ctx.createDynamicsCompressor();
    masterAudioCompressor.threshold.setValueAtTime(-14, ctx.currentTime);
    masterAudioCompressor.knee.setValueAtTime(10, ctx.currentTime);
    masterAudioCompressor.ratio.setValueAtTime(12, ctx.currentTime);
    masterAudioCompressor.attack.setValueAtTime(0.002, ctx.currentTime);
    masterAudioCompressor.release.setValueAtTime(0.08, ctx.currentTime);

    const masterCeiling = ctx.createGain();
    masterCeiling.gain.setValueAtTime(0.85, ctx.currentTime);
    masterAudioCompressor.connect(masterCeiling);
    masterCeiling.connect(ctx.destination);
  }
  return masterAudioCompressor;
}

async function startLiveAudioCapture(stream = null) {
  if (!stream) {
    stream = TokTokState.localUser.mediaStream;
  }
  if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true },
            channelCount: 1
          }
        });
        if (TokTokState.localUser.mediaStream) {
          stream.getAudioTracks().forEach(t => TokTokState.localUser.mediaStream.addTrack(t));
        } else {
          TokTokState.localUser.mediaStream = stream;
        }
      }
    } catch (err) {
      console.warn("No se pudo obtener micrófono para live audio capture:", err);
      return;
    }
  }

  if (!stream) return;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks || audioTracks.length === 0) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    if (liveAudioProcessor) {
      try { liveAudioProcessor.disconnect(); } catch (_) {}
      liveAudioProcessor = null;
    }
    if (liveAudioSource) {
      try { liveAudioSource.disconnect(); } catch (_) {}
      liveAudioSource = null;
    }

    liveAudioSource = ctx.createMediaStreamSource(stream);
    // Buffer size 2048: latencia óptima y compatible con todos los navegadores móviles
    liveAudioProcessor = ctx.createScriptProcessor(2048, 1, 1);

    liveAudioProcessor.onaudioprocess = (e) => {
      if (!TokTokState.localUser.micOn) return;
      if (!isUserOnStage()) return;

      const input = e.inputBuffer.getChannelData(0);

      // Detección de Voz Inteligente (VAD) con Hangover para evitar cortes entre sílabas y robótica
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        sum += input[i] * input[i];
      }
      const rms = Math.sqrt(sum / input.length);

      const VAD_THRESHOLD = 0.002; // Sensibilidad calibrada para voz natural
      if (rms >= VAD_THRESHOLD) {
        speechHangover = 8; // Mantener vivo durante ~350ms tras cada palabra
      } else if (speechHangover > 0) {
        speechHangover--;
      } else {
        return; // Silencio real
      }

      // Filtro anti-aliasing de media móvil (2 muestras) para eliminar asperezas metálicas
      const downsampleFactor = 2;
      const outLen = Math.floor(input.length / downsampleFactor);
      const int16Array = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const idx0 = i * 2;
        const s0 = input[idx0];
        const s1 = (idx0 + 1 < input.length) ? input[idx0 + 1] : s0;
        const smoothed = 0.5 * (s0 + s1);
        const s = Math.max(-1, Math.min(1, smoothed));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Convertir a base64
      let binary = "";
      const bytes = new Uint8Array(int16Array.buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Pcm = btoa(binary);

      const audioPayload = {
        userId: TokTokState.localUser.id,
        pcm: base64Pcm,
        sampleRate: Math.round(ctx.sampleRate / downsampleFactor)
      };

      if (realtimeSocket && realtimeSocket.readyState === 1) {
        realtimeSocket.send(JSON.stringify({ type: "audio_chunk", data: audioPayload }));
      } else {
        fetch("/api/audio/chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(audioPayload)
        }).catch(() => {});
      }
    };

    liveAudioSource.connect(liveAudioProcessor);

    // Conectar a silenceGain (gain = 0) para mantener activo el bucle sin eco local
    const silenceGain = ctx.createGain();
    silenceGain.gain.value = 0;
    liveAudioProcessor.connect(silenceGain);
    silenceGain.connect(ctx.destination);
  } catch (err) {
    console.warn("No se pudo iniciar la captura de audio en vivo:", err);
  }
}

function handleIncomingAudioChunk(data) {
  if (!data || !data.pcm || !data.userId) return;
  if (data.userId === TokTokState.localUser.id) return;

  // Silencio total si el receptor no está dentro del escenario
  if (!isUserOnStage()) return;

  // Si el modal de registro obligatorio o verificación están abiertos, silencio total
  const regModal = document.getElementById("mandatoryRegisterModal");
  const verModal = document.getElementById("emailVerificationModal");
  if ((regModal && regModal.classList.contains("show")) || (verModal && verModal.classList.contains("show"))) {
    return;
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
      if (!document.getElementById("mobileAudioPrompt")) {
        const prompt = document.createElement("div");
        prompt.id = "mobileAudioPrompt";
        prompt.style.cssText = "position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #fe2c55; color: #fff; padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: bold; z-index: 999999; box-shadow: 0 4px 15px rgba(0,0,0,0.5); cursor: pointer; display: flex; align-items: center; gap: 6px;";
        prompt.innerHTML = "<span>🔊 Toca aquí para escuchar</span>";
        prompt.onclick = () => {
          unlockAudioContexts();
          prompt.remove();
        };
        document.body.appendChild(prompt);
      }
    }

    // Decodificar Base64 a Int16
    const binary = atob(data.pcm);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);

    // Convertir a Float32 (-1.0 a +1.0)
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    // ANTI-PETARDEO: Micro-fades suaves de 32 muestras al inicio y al final del chunk
    // Elimina por completo los clicks/pops ("pa, pa, pa") por discontinuidad en las fronteras de audio
    const fadeLen = Math.min(32, Math.floor(float32Array.length / 4));
    for (let i = 0; i < fadeLen; i++) {
      const factor = i / fadeLen;
      float32Array[i] *= factor;
      float32Array[float32Array.length - 1 - i] *= factor;
    }

    // Crear AudioBuffer
    const sampleRate = data.sampleRate || 22050;
    const audioBuffer = ctx.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    // PIPELINE INDEPENDIENTE POR USUARIO (Resuelve solapamiento y petardeo con 2 o más personas)
    let pipeline = userAudioPipelines.get(data.userId);
    if (!pipeline) {
      const userGain = ctx.createGain();
      userGain.gain.value = 0.70; // Margen dinámico limpio para mezcla multi-usuario sin distorsión ni clipping digital
      userGain.connect(getMasterCompressor(ctx));
      pipeline = {
        nextPlayTime: 0,
        gainNode: userGain,
        lastSeen: Date.now()
      };
      userAudioPipelines.set(data.userId, pipeline);
    }
    pipeline.lastSeen = Date.now();

    const now = ctx.currentTime;
    if (pipeline.nextPlayTime < now) {
      pipeline.nextPlayTime = now + 0.04; // 40ms de jitter buffer inicial por usuario
    } else if (pipeline.nextPlayTime - now > 0.25) {
      // Si la cola se desborda (>250ms acumulados por ráfagas de red), descartamos el chunk atrasado en vez de solapar voces
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(pipeline.gainNode);
    source.start(pipeline.nextPlayTime);

    pipeline.nextPlayTime += audioBuffer.duration;

    // Indicador visual de voz en vivo en los asientos
    if (data.userId === "user_dyr_creator") {
      setSlotSpeaking("seat-0", true);
      clearTimeout(window._speakingTimerHost);
      window._speakingTimerHost = setTimeout(() => setSlotSpeaking("seat-0", false), 250);
    } else {
      let speakingSeat = -1;
      if (TokTokState.stageSeats) {
        speakingSeat = TokTokState.stageSeats.findIndex((s, idx) => idx > 0 && s && s.id === data.userId);
      }
      if (speakingSeat <= 0 && TokTokState.guestsOnStage) {
        const g = TokTokState.guestsOnStage.find(item => item && item.id === data.userId);
        if (g && g.seatIndex) speakingSeat = g.seatIndex;
      }
      if (speakingSeat > 0 && speakingSeat <= 15) {
        setSlotSpeaking(`seat-${speakingSeat}`, true);
        clearTimeout(window[`_speakingTimerGuest_${speakingSeat}`]);
        window[`_speakingTimerGuest_${speakingSeat}`] = setTimeout(() => setSlotSpeaking(`seat-${speakingSeat}`, false), 250);
      }
    }
  } catch (err) {
    console.warn("Error reproduciendo chunk de audio:", err);
  }
}

function sendPresenceHeartbeat() {
  if (!TokTokState.localUser || !TokTokState.localUser.id) return;

  fetch("/api/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: TokTokState.localUser.id,
      name: TokTokState.localUser.name,
      handle: TokTokState.localUser.handle,
      email: TokTokState.localUser.email,
      avatarBg: TokTokState.localUser.avatarBg,
      isCreator: TokTokState.localUser.isCreator,
      isHost: TokTokState.localUser.isHost,
      cameraOn: TokTokState.localUser.cameraOn,
      micOn: TokTokState.localUser.micOn
    })
  })
  .then(res => {
    if (res.status === 403) {
      showBannedScreenOverlay();
      return null;
    }
    return res.json();
  })
  .then(data => {
    if (!data) return;
    if (data.isBanned) {
      showBannedScreenOverlay();
      return;
    }
    if (data.stageSeats) syncStageSeats(data.stageSeats);
    if (data.onlineUsers) syncOnlineUsers(data.onlineUsers);

    // ENTREGA GARANTIZADA DE INVITACIÓN:
    // Si el servidor tiene una invitación pendiente para este usuario y no está ya en el escenario
    if (data.pendingInvite) {
      const isAlreadyOnStage = TokTokState.guestsOnStage.some(g => g && g.id === TokTokState.localUser.id);
      if (!isAlreadyOnStage && !TokTokState.localUser.isHost) {
        handleIncomingStageInvite(data.pendingInvite);
      }
    }
  })
  .catch(() => {});
}

function syncOnlineUsers(onlineList) {
  if (!Array.isArray(onlineList)) return;

  const onlineMap = new Map();
  onlineList.forEach(u => onlineMap.set(u.id, u));

  let changed = false;

  // Actualizar estado de usuarios existentes
  TokTokState.registeredUsers.forEach(u => {
    const isNowOnline = onlineMap.has(u.id) || u.id === TokTokState.localUser.id;
    const newStatus = isNowOnline ? "online" : "offline";
    if (u.status !== newStatus) {
      u.status = newStatus;
      changed = true;
    }
  });

  // Agregar usuarios conectados que no estén aún en la lista local
  onlineList.forEach(u => {
    if (u.id === TokTokState.localUser.id) return;
    const exists = TokTokState.registeredUsers.some(r => r.id === u.id || (r.email && r.email.toLowerCase() === (u.email || '').toLowerCase()));
    if (!exists) {
      TokTokState.registeredUsers.unshift({
        id: u.id,
        name: u.name,
        handle: u.handle && u.handle.startsWith("@") ? u.handle : `@${u.handle || 'usuario'}`,
        email: u.email || `${u.handle}@tokroom.live`,
        avatarBg: u.avatarBg || "#fe2c55",
        bio: u.isCreator ? "👑 Creador Oficial" : "Conectado en vivo ahora 🟢",
        status: "online",
        colorHue: 335
      });
      changed = true;
    }
  });

  if (changed) {
    saveRegisteredUsers();
    renderRegisteredUsersDirectory();
    renderStageGuestsListTab();
  }
}

function syncStageSeats(seats) {
  if (!Array.isArray(seats)) return;

  TokTokState.stageSeats = seats;

  const guests = [];
  for (let i = 1; i < seats.length && i <= 15; i++) {
    if (seats[i]) {
      guests.push({
        id: seats[i].id,
        name: seats[i].name,
        handle: seats[i].handle,
        avatarBg: seats[i].avatarBg,
        email: seats[i].email,
        seatIndex: i,
        cameraOn: seats[i].cameraOn !== undefined ? seats[i].cameraOn : true,
        micOn: seats[i].micOn !== undefined ? seats[i].micOn : true,
        isSpeaking: false,
        colorHue: seats[i].colorHue || (i * 25 + 100) % 360
      });
    }
  }

  const prevIds = TokTokState.guestsOnStage.map(g => `${g.id}:${g.seatIndex}:${g.micOn}:${g.cameraOn}`).join(",");
  const nextIds = guests.map(g => `${g.id}:${g.seatIndex}:${g.micOn}:${g.cameraOn}`).join(",");

  if (prevIds !== nextIds || !document.getElementById("seat-1")) {
    TokTokState.guestsOnStage = guests;
    renderVideoGrid();
    renderRegisteredUsersDirectory();
    renderStageGuestsListTab();
    updateStageCapacityBadges();
    syncWebRTCVideoAudioPeers();
  }
}

function handleIncomingStageInvite(data) {
  const banner = document.getElementById("incomingRequestBanner");
  const avatar = document.getElementById("reqAvatar");
  const username = document.getElementById("reqUsername");
  const actionText = document.querySelector(".req-action-text");
  const acceptBtn = document.getElementById("acceptIncomingReqBtn");
  const rejectBtn = document.getElementById("rejectIncomingReqBtn");

  if (!banner) return;

  playSoundFx("fanfare");
  if (username) username.textContent = `${data.fromUser.name} (${data.fromUser.handle || '@dyr'})`;
  if (actionText) actionText.textContent = "🌟 ¡Te ha invitado a subir al escenario en vivo con cámara y micrófono!";
  if (avatar) avatar.textContent = "👑";

  banner.style.display = "block";
  requestAnimationFrame(() => banner.classList.add("show"));

  const newAccept = acceptBtn.cloneNode(true);
  const newReject = rejectBtn.cloneNode(true);
  acceptBtn.parentNode.replaceChild(newAccept, acceptBtn);
  rejectBtn.parentNode.replaceChild(newReject, rejectBtn);

  newAccept.textContent = "✅ Aceptar y Transmitir";
  newReject.textContent = "❌ Ahora no";

  newAccept.addEventListener("click", () => {
    unlockAudioContexts();
    enterLiveRoom();
    banner.classList.remove("show");
    banner.style.display = "none";
    setupLocalCamera().then(() => {
      fetch("/api/invite/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: TokTokState.localUser.id,
          accepted: true,
          seatIndex: data.seatIndex || null,
          handle: TokTokState.localUser.handle,
          name: TokTokState.localUser.name
        })
      }).then(res => res.json()).then(() => {
        playSoundFx("fanfare");
        alert("🎉 ¡Has subido al escenario en vivo! Tu cámara y micrófono están transmitiendo.");
        syncWebRTCVideoAudioPeers();
      });
    });
  });

  newReject.addEventListener("click", () => {
    banner.classList.remove("show");
    banner.style.display = "none";
    fetch("/api/invite/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: TokTokState.localUser.id,
        accepted: false,
        handle: TokTokState.localUser.handle,
        name: TokTokState.localUser.name
      })
    });
  });
}

// ===================================================================
// MOTOR WEBRTC: VIDEO Y AUDIO BIDIRECCIONAL EN TIEMPO REAL
// CONEXIÓN ENTRE ANFITRIÓN (DYR) E INVITADOS (ROSA Y OTROS)
// ===================================================================
const rtcPeerConnections = new Map(); // peerId -> RTCPeerConnection
const remoteStreams = new Map();      // peerId -> MediaStream
const rtcIceConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ]
};

function syncWebRTCVideoAudioPeers() {
  const isHost = TokTokState.localUser.isHost || TokTokState.localUser.isCreator;
  const myId = TokTokState.localUser.id;

  if (isHost) {
    // Si soy el Host (DYR): iniciar conexión con cada invitado en el escenario
    TokTokState.guestsOnStage.forEach(g => {
      if (g && g.id && g.id !== myId) {
        initWebRTCConnection(g.id, true);
      }
    });
  } else {
    // Si soy un invitado en el escenario: conectar con el Host
    const amOnStage = TokTokState.guestsOnStage.some(g => g && g.id === myId);
    if (amOnStage) {
      initWebRTCConnection("user_dyr_creator", false);
    }
  }
}

async function initWebRTCConnection(targetUserId, shouldOffer) {
  if (rtcPeerConnections.has(targetUserId)) {
    const existing = rtcPeerConnections.get(targetUserId);
    if (existing && existing.connectionState !== "closed" && existing.connectionState !== "failed") {
      // Ya conectado o conectando
      return;
    }
  }

  const pc = new RTCPeerConnection(rtcIceConfig);
  rtcPeerConnections.set(targetUserId, pc);

  // Adjuntar todas las pistas locales (Audio Y Video)
  if (TokTokState.localUser.mediaStream) {
    TokTokState.localUser.mediaStream.getTracks().forEach(track => {
      pc.addTrack(track, TokTokState.localUser.mediaStream);
    });
  }

  // Recepción de pistas remotas del otro participante
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    remoteStreams.set(targetUserId, stream);
    playRemoteAudioStream(stream);
    attachRemoteStreamToSeat(targetUserId, stream);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWebRTCSignal({
        type: "candidate",
        candidate: event.candidate,
        senderId: TokTokState.localUser.id,
        targetUserId
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`📡 WebRTC estado con ${targetUserId}: ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      const stream = remoteStreams.get(targetUserId);
      if (stream) attachRemoteStreamToSeat(targetUserId, stream);
    }
  };

  if (shouldOffer) {
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await pc.setLocalDescription(offer);
      sendWebRTCSignal({
        type: "offer",
        sdp: offer,
        senderId: TokTokState.localUser.id,
        targetUserId
      });
    } catch (err) {
      console.warn("Error creando oferta WebRTC:", err);
    }
  }
}

function sendWebRTCSignal(signal) {
  fetch("/api/webrtc/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signal)
  }).catch(() => {});
}

async function handleWebRTCSignal(data) {
  if (!data || data.senderId === TokTokState.localUser.id) return;
  if (data.targetUserId && data.targetUserId !== TokTokState.localUser.id) return;

  const peerId = data.senderId;
  let pc = rtcPeerConnections.get(peerId);

  if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") {
    pc = new RTCPeerConnection(rtcIceConfig);
    rtcPeerConnections.set(peerId, pc);

    if (TokTokState.localUser.mediaStream) {
      TokTokState.localUser.mediaStream.getTracks().forEach(track => {
        pc.addTrack(track, TokTokState.localUser.mediaStream);
      });
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      remoteStreams.set(peerId, stream);
      playRemoteAudioStream(stream);
      attachRemoteStreamToSeat(peerId, stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWebRTCSignal({
          type: "candidate",
          candidate: event.candidate,
          senderId: TokTokState.localUser.id,
          targetUserId: peerId
        });
      }
    };
  }

  try {
    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // Asegurar que transmitimos nuestras pistas locales al anfitrión
      if (TokTokState.localUser.mediaStream) {
        TokTokState.localUser.mediaStream.getTracks().forEach(track => {
          const senders = pc.getSenders();
          if (!senders.some(s => s.track && s.track.kind === track.kind)) {
            pc.addTrack(track, TokTokState.localUser.mediaStream);
          }
        });
      }

      const answer = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await pc.setLocalDescription(answer);

      sendWebRTCSignal({
        type: "answer",
        sdp: answer,
        senderId: TokTokState.localUser.id,
        targetUserId: peerId
      });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "candidate") {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.warn("WebRTC signal error:", err);
  }
}

function attachRemoteStreamToSeat(peerId, stream) {
  if (!stream) return;

  // 1. Si el peer es el Host (DYR):
  if (peerId === "user_dyr_creator") {
    const hostVideo = document.getElementById("hostRemoteVideo");
    if (hostVideo) {
      if (hostVideo.srcObject !== stream) {
        hostVideo.srcObject = stream;
      }
      hostVideo.playsInline = true;
      hostVideo.setAttribute("playsinline", "");
      hostVideo.setAttribute("webkit-playsinline", "");
      hostVideo.style.display = "block";
      hostVideo.play().catch(() => {});
      const hostOff = document.getElementById("localVideoOffHolder");
      if (hostOff) hostOff.style.display = "none";
    }
    return;
  }

  // 2. Si el peer es un invitado: buscar su asiento exacto en stageSeats
  let targetSeatIndex = -1;
  if (TokTokState.stageSeats) {
    targetSeatIndex = TokTokState.stageSeats.findIndex((s, idx) => idx > 0 && s && s.id === peerId);
  }
  if (targetSeatIndex <= 0 && TokTokState.guestsOnStage) {
    const g = TokTokState.guestsOnStage.find(item => item && item.id === peerId);
    if (g && g.seatIndex) targetSeatIndex = g.seatIndex;
  }

  if (targetSeatIndex > 0 && targetSeatIndex <= 15) {
    const guestVideo = document.getElementById(`video-guest-${targetSeatIndex}`);
    if (guestVideo) {
      if (guestVideo.srcObject !== stream) {
        guestVideo.srcObject = stream;
      }
      guestVideo.playsInline = true;
      guestVideo.setAttribute("playsinline", "");
      guestVideo.setAttribute("webkit-playsinline", "");
      guestVideo.style.display = "block";
      guestVideo.play().catch(() => {});
      const offHolder = document.getElementById(`guestVideoOff-${targetSeatIndex}`);
      if (offHolder) offHolder.style.display = "none";
    }
  }
}

function playRemoteAudioStream(stream) {
  let remoteAudio = document.getElementById("tokLiveRemoteAudio");
  if (!remoteAudio) {
    remoteAudio = document.createElement("audio");
    remoteAudio.id = "tokLiveRemoteAudio";
    remoteAudio.autoplay = true;
    remoteAudio.playsInline = true;
    document.body.appendChild(remoteAudio);
  }
  remoteAudio.srcObject = stream;
  remoteAudio.muted = true; // El audio unificado se reproduce a través del pipeline Web Audio con control dinámico y anti-petardeo
  remoteAudio.play().catch(e => {
    console.debug("Interacción requerida para reproducir audio:", e);
  });
}

// Desbloqueo de audio en navegadores móviles (iOS Safari)
window.addEventListener("click", () => {
  const audio = document.getElementById("tokLiveRemoteAudio");
  if (audio && audio.paused && audio.srcObject) {
    audio.play().catch(() => {});
  }
}, { passive: true });

window.addEventListener("touchstart", () => {
  const audio = document.getElementById("tokLiveRemoteAudio");
  if (audio && audio.paused && audio.srcObject) {
    audio.play().catch(() => {});
  }
}, { passive: true });

// ===================================================================
// SISTEMA DE BLOQUEO Y EXPULSIÓN DE USUARIOS
// ===================================================================
function banUser(user) {
  if (!user) return;
  const targetId = user.id || "";
  const targetHandle = user.handle || "";
  const targetName = user.name || "";

  // 1. Expulsar de inmediato del escenario
  removeGuestFromStage(targetId || targetHandle || targetName);

  // 2. Registrar en la lista de bloqueados local
  TokTokState.moderation.bannedUserIds.push({
    id: targetId,
    name: targetName,
    handle: targetHandle,
    reason: "Bloqueado por el Anfitrión"
  });
  renderBannedUsersList();

  // 3. Notificar al servidor en tiempo real
  fetch("/api/ban", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: targetId,
      handle: targetHandle,
      name: targetName
    })
  }).catch(() => {});

  addChatMessage("🛡️ Moderación", `🚫 ${targetName} (${targetHandle}) ha sido BLOQUEADO y EXPULSADO de la sala.`);
  playSoundFx("pop");
  alert(`🚫 ${targetName} ha sido expulsado y bloqueado de la sala. No podrá escribir ni unirse.`);
}

function showBannedScreenOverlay() {
  let overlay = document.getElementById("bannedScreenOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "bannedScreenOverlay";
    overlay.className = "banned-screen-overlay";
    overlay.innerHTML = `
      <div class="banned-box">
        <div class="banned-icon">🚫</div>
        <h2 style="color: #fe2c55; margin-bottom: 12px; font-size: 22px;">Has sido Bloqueado</h2>
        <p style="color: var(--text-secondary); font-size: 14px; line-height: 1.5; margin-bottom: 20px;">
          El anfitrión de la sala te ha bloqueado. No tienes permisos para encender tu cámara, subir al escenario ni enviar mensajes al chat.
        </p>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 18px;">
          Debes esperar a que el anfitrión levante el bloqueo para poder participar nuevamente.
        </div>
        <button type="button" id="btnCheckIfUnbanned" style="background: #00e676; color: #000; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 800; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
          🔄 Comprobar si he sido Desbloqueado
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    const btnCheck = document.getElementById("btnCheckIfUnbanned");
    if (btnCheck) {
      btnCheck.addEventListener("click", () => {
        window.location.reload();
      });
    }
  }
  overlay.style.display = "flex";

  // Desactivar cámara y micrófono local
  if (TokTokState.localUser.mediaStream) {
    TokTokState.localUser.mediaStream.getTracks().forEach(t => t.stop());
    TokTokState.localUser.mediaStream = null;
  }
  TokTokState.localUser.cameraOn = false;
  TokTokState.localUser.micOn = false;
  renderVideoGrid();

  // Inhabilitar chat
  const chatInput = document.getElementById("chatInput");
  const chatBtn = document.querySelector(".btn-chat-send");
  if (chatInput) {
    chatInput.disabled = true;
    chatInput.placeholder = "🚫 Estás bloqueado de la sala";
  }
  if (chatBtn) chatBtn.disabled = true;
}

function hideBannedScreenOverlay() {
  const overlay = document.getElementById("bannedScreenOverlay");
  if (overlay) overlay.style.display = "none";

  const chatInput = document.getElementById("chatInput");
  const chatBtn = document.querySelector(".btn-chat-send");
  if (chatInput) {
    chatInput.disabled = false;
    chatInput.placeholder = "Añade un comentario...";
  }
  if (chatBtn) chatBtn.disabled = false;
}

// ===================================================================
// SISTEMA DE SALAS EN VIVO INDEPENDIENTES (MULTI-SALA)
// ===================================================================
function updateRoomNameUI(roomName) {
  if (!roomName) return;
  TokTokState.roomName = roomName;
  const titleDisplay = document.getElementById("roomTitleDisplay");
  if (titleDisplay) {
    titleDisplay.innerHTML = `Tok Tok Live • ${roomName} <span style="font-size: 11px; color: #fe2c55; border: 1px solid #fe2c55; padding: 1px 5px; border-radius: 4px; vertical-align: middle; margin-left: 6px; font-weight: 800;">+18</span>`;
  }
  const lobbyTitle = document.getElementById("lobbyRoomTitle");
  if (lobbyTitle) {
    lobbyTitle.textContent = roomName;
  }
}

function openRoomsListModal() {
  fetch("/api/rooms")
    .then(res => res.json())
    .then(data => {
      if (data && data.rooms) {
        renderRoomsList(data.rooms);
      }
      openModal("roomsListModal");
    })
    .catch(() => openModal("roomsListModal"));
}

function isDavidUser() {
  const u = TokTokState.localUser;
  if (!u) return false;
  const email = (u.email || "").toLowerCase().trim();
  const id = (u.id || "").toLowerCase().trim();
  const handle = (u.handle || "").toLowerCase().replace('@', '').trim();
  const name = (u.name || "").toLowerCase().trim();
  return email === "davidyrosa1979@gmail.com" || id === "user_dyr_creator" || handle === "dyr" || name === "dyr" || !!u.isCreator;
}

async function deleteRoom(roomId, redirectHome = false) {
  if (!roomId) return;
  const isMain = (roomId === "main");
  const confirmMsg = isMain
    ? "⚠️ ¿Deseas REINICIAR completamente la Sala Principal de Tok Tok (limpiar escenario y chat)?"
    : "🗑️ ¿Estás seguro de que deseas ELIMINAR definitivamente esta sala en vivo?\n\nTodos los usuarios que estén dentro serán redirigidos a la Sala Principal.";

  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch("/api/rooms/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId,
        userId: TokTokState.localUser.id,
        userHandle: TokTokState.localUser.handle,
        userEmail: TokTokState.localUser.email
      })
    });
    const data = await res.json();
    if (data && data.ok) {
      alert(isMain ? "🔄 Sala principal reiniciada correctamente." : "✅ Sala eliminada exitosamente.");
      if (redirectHome || TokTokState.roomId === roomId) {
        window.location.href = window.location.pathname;
      } else {
        openRoomsListModal();
      }
    } else {
      alert(data.error || "No tienes permisos para eliminar esta sala.");
    }
  } catch (err) {
    console.error("Error al eliminar sala:", err);
    alert("Error de conexión al intentar eliminar la sala.");
  }
}

function renderRoomsList(rooms) {
  const container = document.getElementById("roomsListGridContainer");
  if (!container) return;
  container.innerHTML = "";

  if (!rooms || rooms.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 20px;">No hay salas activas en este momento. ¡Sé el primero en crear una!</div>`;
    return;
  }

  const isDavid = isDavidUser();
  let myCreatedRooms = [];
  try {
    myCreatedRooms = JSON.parse(localStorage.getItem("toktok_my_created_rooms") || "[]");
  } catch (_) {}

  rooms.forEach(r => {
    const isCurrent = (r.id === TokTokState.roomId);
    const isMain = (r.id === "main");
    const isMyRoom = myCreatedRooms.includes(r.id) || 
                     (TokTokState.localUser && (
                       TokTokState.localUser.id === r.creatorId || 
                       (TokTokState.localUser.handle && r.creatorHandle && TokTokState.localUser.handle.toLowerCase().replace('@','') === r.creatorHandle.toLowerCase().replace('@','')) ||
                       (TokTokState.localUser.name && r.creatorName && TokTokState.localUser.name.toLowerCase() === r.creatorName.toLowerCase())
                     ));
    const canDelete = isDavid || (!isMain && isMyRoom);

    const card = document.createElement("div");
    card.className = `room-card-item ${isCurrent ? 'active-current' : ''}`;
    card.innerHTML = `
      <div class="room-card-header">
        <h4 class="room-card-title">${r.name}</h4>
        ${isCurrent ? '<span style="font-size: 10px; background: #fe2c55; color: #fff; padding: 2px 6px; border-radius: 4px; font-weight: 800;">ACTUAL</span>' : ''}
      </div>
      <div class="room-card-host">👑 Anfitrión: <strong>${r.creatorName || 'DYR'}</strong></div>
      <div class="room-card-stats">
        <span>👥 ${r.userCount || 0} espectadores</span>
        <span>🪑 ${r.seatedCount || 0}/15 en vivo</span>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 10px; align-items: stretch;">
        <button class="btn-join-room-card" style="flex: 1;" ${isCurrent ? 'disabled style="opacity: 0.6; cursor: default; flex: 1;"' : ''}>
          ${isCurrent ? 'Estás en esta sala' : '🔴 Entrar a Sala'}
        </button>
        ${canDelete ? `
          <button class="btn-delete-room-card" data-room-id="${r.id}" title="${isMain ? 'Reiniciar Sala Principal' : 'Eliminar Sala Definitivamente'}" style="background: rgba(254, 44, 85, 0.15); border: 1px solid #fe2c55; color: #fe2c55; border-radius: 8px; padding: 0 12px; font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.2s;">
            🗑️ ${isMain ? 'Reiniciar' : 'Eliminar'}
          </button>
        ` : ''}
      </div>
    `;

    if (!isCurrent) {
      const joinBtn = card.querySelector(".btn-join-room-card");
      if (joinBtn) {
        joinBtn.addEventListener("click", () => {
          switchRoom(r.id);
        });
      }
    }

    if (canDelete) {
      const delBtn = card.querySelector(".btn-delete-room-card");
      if (delBtn) {
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteRoom(r.id);
        });
      }
    }

    container.appendChild(card);
  });
}

function switchRoom(targetRoomId) {
  if (!targetRoomId || targetRoomId === TokTokState.roomId) return;
  window.location.href = `${window.location.pathname}?room=${encodeURIComponent(targetRoomId)}`;
}

function createNewIndependentRoom(roomName) {
  if (!roomName || !roomName.trim()) return;

  fetch("/api/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomName: roomName.trim(),
      user: TokTokState.localUser
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data && data.ok && data.roomId) {
      // Guardar que este usuario creó esta sala para concederle rango de anfitrión permanente
      try {
        const myRooms = JSON.parse(localStorage.getItem("toktok_my_created_rooms") || "[]");
        if (!myRooms.includes(data.roomId)) {
          myRooms.push(data.roomId);
          localStorage.setItem("toktok_my_created_rooms", JSON.stringify(myRooms));
        }
      } catch (_) {}

      alert(`🎉 ¡Tu sala "${data.roomName}" ha sido creada con éxito!\n\nSerás el Anfitrión de tu sala e invitarás a hasta 15 amigos independientes.`);
      window.location.href = `${window.location.pathname}?room=${encodeURIComponent(data.roomId)}&host=1`;
    } else {
      alert("No se pudo crear la sala. Por favor intenta de nuevo.");
    }
  })
  .catch(err => {
    console.error(err);
    alert("Error al conectar con el servidor para crear la sala.");
  });
}

function shareCurrentRoom() {
  const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const defaultPublicUrl = "https://tok-tok-live.onrender.com";
  const baseOrigin = isLocalhost ? defaultPublicUrl : window.location.origin;
  const roomParam = TokTokState.roomId && TokTokState.roomId !== "main" ? `?room=${encodeURIComponent(TokTokState.roomId)}` : "";
  const shareUrl = `${baseOrigin}/${roomParam}`;
  const text = `¡Únete a mi sala en vivo "${TokTokState.roomName || 'Tok Tok Live'}"! Entra directamente desde tu móvil: ${shareUrl}`;

  if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(() => {
      if (confirm(`🔗 ¡Enlace de tu sala copiado al portapapeles!\n\n${shareUrl}\n\n¿Deseas compartirlo ahora directamente por WhatsApp con tus amigos?`)) {
        window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
      }
    }).catch(() => {
      prompt("Copia este enlace para compartir tu sala:", shareUrl);
    });
  } else {
    prompt("Copia este enlace para compartir tu sala:", shareUrl);
  }
}

function initTokTokApp() {
  loadRegisteredUsers();
  loadDmInbox();
  loadLocalProfile();
  updateModeratorAccessUI();
  renderVideoGrid();
  renderGiftsCatalog();
  renderRegisteredUsersDirectory();
  setupEventListeners();
  setupMobileViewNavigation();
  updateRoomNameUI(TokTokState.roomName);
  checkMandatoryRegistration();
  checkRoomEntrance();
  setupLocalCamera();
  initRealtimeSync();

  addChatMessage("TokTokBot", `👋 ¡Bienvenido a ${TokTokState.roomName || 'Tok Tok Live'} (+18)! Sala independiente en tiempo real lista.`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTokTokApp);
} else {
  initTokTokApp();
}
