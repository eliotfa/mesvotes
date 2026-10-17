// Configuration lue dans les variables d'environnement (voir .env.example).
import path from "node:path";
import { PARAMS, DEFAULT_PARAMS } from "../public/shared/constitution.js";

const env = process.env;
const bool = (v, d = false) => v === undefined || v === "" ? d : /^(1|true|yes|oui)$/i.test(v);
const snake = k => k.replace(/[A-Z]/g, m => "_" + m).toUpperCase();

const baseUrl = (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, "");

// Valeurs de la Constitution fondatrice, ajustables au premier lancement (INIT_PARRAINAGE_MIN=3, etc.).
const initialParams = { ...DEFAULT_PARAMS };
for (const p of PARAMS) {
  const v = env["INIT_" + snake(p.k)];
  if (v !== undefined && v !== "" && Number.isFinite(Number(v))) initialParams[p.k] = Number(v);
}

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || "0.0.0.0",
  baseUrl,
  dataDir: path.resolve(env.DATA_DIR || "./data"),
  cookieSecure: bool(env.COOKIE_SECURE, baseUrl.startsWith("https://")),
  trustProxy: bool(env.TRUST_PROXY, false),
  demoMode: bool(env.DEMO_MODE, false),
  seedDemo: bool(env.SEED_DEMO, false),
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
  maxUserStorageBytes: Number(env.MAX_USER_STORAGE_MB || 200) * 1024 * 1024,
  tickSeconds: Number(env.TICK_SECONDS || 60),
  initialParams,
  goalMembers: Number(env.GOAL_MEMBERS || 1000000),
  legal: {
    name: env.LEGAL_NAME || "Eliot Faggianelli",
    email: env.LEGAL_EMAIL || "",
    address: env.LEGAL_ADDRESS || "",
    hostName: env.HOSTING_NAME || "",
    hostAddress: env.HOSTING_ADDRESS || "",
    hostPhone: env.HOSTING_PHONE || "",
    hostLocation: env.HOSTING_LOCATION || ""
  },
  smtp: {
    host: env.SMTP_HOST || "",
    port: Number(env.SMTP_PORT || 587),
    secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT) === 465),
    user: env.SMTP_USER || "",
    pass: env.SMTP_PASS || "",
    from: env.MAIL_FROM || "mesvotes <ne-pas-repondre@mesvotes.fr>"
  }
};
config.mailEnabled = Boolean(config.smtp.host);
