const express = require("express");
const path = require("path");
const crypto = require("crypto");
const cookieSession = require("cookie-session");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const ROOT = __dirname;
const ADMINS_FILE = path.join(ROOT, "admins.json");

let _client;
let _db;

async function getDB() {
    if (!_db) {
        _client = new MongoClient(process.env.MONGODB_URI, {
            serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
        });
        await _client.connect();
        _db = _client.db("servercodes");
    }
    return _db;
}

app.set("trust proxy", 1);

app.use(express.json());

app.use(cookieSession({
    name: "session",
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax"
}));

app.use(express.static(path.join(ROOT, "public")));

/* code */
function genCode() {
    return crypto.randomBytes(3).toString("hex").toUpperCase();
}

/* Admin auth */

function loadAdmins() {
    return JSON.parse(require("fs").readFileSync(ADMINS_FILE, "utf-8"));
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

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

/* Auth routes */

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const admins = loadAdmins();
    if (admins.length === 0) return res.status(403).json({ error: "No admin configured." });
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
app.post("/api/validate", async (req, res) => {
    try {
        const { code, player, xuid } = req.body;
        if (!code) return res.json({ valid: false, reason: "No code provided." });

        const db = await getDB();
        const entry = await db.collection("codes").findOne({ code: code.toUpperCase() });

        if (!entry) return res.json({ valid: false, reason: "Invalid code." });
        if (Date.now() > entry.expiresAt) return res.json({ valid: false, reason: "Code expired." });
        if (entry.expiredByLeave) return res.json({ valid: false, reason: "Code expired due to leaving the server." });

        if (entry.uses !== null && entry.uses !== undefined && entry.uses <= 0) return res.json({ valid: false, reason: "Code fully redeemed." });

        if (entry.uses !== null && entry.uses !== undefined) {
            await db.collection("codes").updateOne({ code: code.toUpperCase() }, { $inc: { uses: -1 } });
            if (entry.type === "temporary") {
                await db.collection("codes").updateOne({ code: code.toUpperCase() }, { $set: { redeemed: true } });
            }
        }

        await db.collection("redeemed").insertOne({
            code: code.toUpperCase(),
            player: player || "?",
            xuid: xuid || "?",
            at: new Date().toISOString()
        });

        res.json({ valid: true });
    } catch (e) {
        res.status(500).json({ valid: false, reason: "Server error" });
    }
});

/* Generate a code */
app.post("/api/generate", requireAuth, async (req, res) => {
    try {
        const months = req.body.months || 1;
        const uses = req.body.uses ?? null;
        const db = await getDB();
        const code = genCode();
        const doc = {
            code,
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + months * 30 * 24 * 60 * 60 * 1000,
            months,
            uses: uses === null ? null : uses
        };
        await db.collection("codes").insertOne(doc);
        res.json({ code, months, uses, command: `/setcode ${code} ${months}` });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

/* Admin: list codes */
app.get("/api/codes", requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        const codes = await db.collection("codes").find().toArray();
        res.json(codes);
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

/* Admin: list redemptions */
app.get("/api/redeemed", requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        const list = await db.collection("redeemed").find().toArray();
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

/* Admin: delete a code */
app.delete("/api/codes/:code", requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        await db.collection("codes").deleteOne({ code: req.params.code.toUpperCase() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

/* Check if a redeemed player's code has expired */
app.post("/api/check-expired", async (req, res) => {
    try {
        const { xuid } = req.body;
        if (!xuid) return res.json({ expired: false });

        const db = await getDB();
        const redemption = await db.collection("redeemed").findOne({ xuid });
        if (!redemption) return res.json({ expired: false });

        const codeEntry = await db.collection("codes").findOne({ code: redemption.code });
        if (!codeEntry) return res.json({ expired: true });
        if (Date.now() > codeEntry.expiresAt) return res.json({ expired: true });
        if (codeEntry.expiredByLeave) return res.json({ expired: true });
        if (codeEntry.uses !== null && codeEntry.uses !== undefined && codeEntry.uses <= 0) return res.json({ expired: true });

        res.json({ expired: false });
    } catch (e) {
        res.status(500).json({ expired: false });
    }
});

/* Expire all codes for a Discord user who left the guild */
app.post("/api/expire-by-discord", async (req, res) => {
    try {
        const { discordId } = req.body;
        if (!discordId) return res.status(400).json({ error: "discordId required" });

        const db = await getDB();
        const result = await db.collection("codes").updateMany(
            { discordId, expiredByLeave: { $ne: true } },
            { $set: { expiredByLeave: true, expiredAtLeave: new Date().toISOString() } }
        );
        res.json({ success: true, expiredCount: result.modifiedCount });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = app;
