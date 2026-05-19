const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cookieSession = require("cookie-session");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "codes.json");
const ADMINS_FILE = path.join(__dirname, "admins.json");

app.set("trust proxy", 1);

app.use(express.json());

app.use(cookieSession({
    name: "session",
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax"
}));

app.use(express.static(path.join(__dirname, "public")));

function load() {
    if (!fs.existsSync(DATA_FILE)) {
        const d = { codes: [], redeemed: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
        return d;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function save(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function genCode() {
    return crypto.randomBytes(3).toString("hex").toUpperCase();
}

/* Admin auth helpers */

function loadAdmins() {
    if (!fs.existsSync(ADMINS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ADMINS_FILE, "utf-8"));
}

function saveAdmins(list) {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify(list, null, 2));
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(":");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return hash === derived;
}

function requireAuth(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).json({ error: "Unauthorized" });
}

/* Auth routes */

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const admins = loadAdmins();
    if (admins.length === 0) return res.status(403).json({ error: "No admin configured. Create an admins.json file in the website directory." });
    const admin = admins.find(a => a.username === username);
    if (!admin || !verifyPassword(password, admin.password)) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    req.session.admin = { username };
    res.json({ success: true, username });
});

app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/me", (req, res) => {
    if (req.session.admin) return res.json({ authenticated: true, username: req.session.admin.username });
    res.json({ authenticated: false });
});

/* Validate a redemption code */
app.post("/api/validate", (req, res) => {
    const { code, player, xuid } = req.body;
    if (!code) return res.json({ valid: false, reason: "No code provided." });

    const data = load();
    const entry = data.codes.find((c) => c.code === code.toUpperCase());

    if (!entry) return res.json({ valid: false, reason: "Invalid code." });
    if (Date.now() > entry.expiresAt) return res.json({ valid: false, reason: "Code expired." });

    if (entry.uses !== null && entry.uses <= 0) return res.json({ valid: false, reason: "Code fully redeemed." });
    if (entry.uses !== null) entry.uses--;

    data.redeemed.push({ code: code.toUpperCase(), player: player || "?", xuid: xuid || "?", at: new Date().toISOString() });
    save(data);
    res.json({ valid: true });
});

/* Generate a code */
app.post("/api/generate", requireAuth, (req, res) => {
    const months = req.body.months || 1;
    const uses = req.body.uses ?? null;
    const data = load();
    const code = genCode();
    data.codes.push({ code, createdAt: new Date().toISOString(), expiresAt: Date.now() + months * 30 * 24 * 60 * 60 * 1000, months, uses });
    save(data);
    res.json({ code, months, uses, command: `/setcode ${code} ${months}` });
});

/* Admin: list codes */
app.get("/api/codes", requireAuth, (req, res) => res.json(load().codes));

/* Admin: list redemptions */
app.get("/api/redeemed", requireAuth, (req, res) => res.json(load().redeemed));

/* Admin: delete a code */
app.delete("/api/codes/:code", requireAuth, (req, res) => {
    const data = load();
    data.codes = data.codes.filter((c) => c.code !== req.params.code.toUpperCase());
    save(data);
    res.json({ success: true });
});

/* Check if a redeemed player's code has expired */
app.post("/api/check-expired", (req, res) => {
    const { xuid } = req.body;
    if (!xuid) return res.json({ expired: false });

    const data = load();
    const redemption = data.redeemed.find((r) => r.xuid === xuid);
    if (!redemption) return res.json({ expired: false });

    const codeEntry = data.codes.find((c) => c.code === redemption.code);
    if (!codeEntry) return res.json({ expired: true });
    if (Date.now() > codeEntry.expiresAt) return res.json({ expired: true });

    res.json({ expired: false });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    const admins = loadAdmins();
    if (admins.length === 0) {
        console.log("No admin account found. Create one by adding an entry to admins.json:");
        console.log(JSON.stringify([{ username: "admin", password: "<hashed>" }], null, 2));
        console.log("Use the hashPassword function from server.js to generate a password hash.");
    }
});
