const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const PORT = process.env.SYNC_PORT || 3457;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("ERROR: Set MONGODB_URI environment variable");
    process.exit(1);
}

let _client;
let _db;

async function getDB() {
    if (!_db) {
        _client = new MongoClient(MONGODB_URI, {
            serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
        });
        await _client.connect();
        _db = _client.db("servercodes");
        console.log("Connected to MongoDB");
    }
    return _db;
}

app.get("/api/codes", async (req, res) => {
    try {
        const db = await getDB();
        const codes = await db.collection("codes").find({}).toArray();
        const output = codes.map(c => ({
            code: c.code,
            type: c.type || "monthly",
            gamertag: c.gamertag || "imported",
            createdAt: c.createdAt || new Date().toISOString(),
            expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : Date.now() + 30 * 24 * 60 * 60 * 1000,
            uses: c.uses !== undefined ? c.uses : null,
            active: c.active !== false
        }));
        res.json(output);
    } catch (e) {
        console.error("Error fetching codes:", e);
        res.status(500).json({ error: "Failed to fetch codes" });
    }
});

app.get("/api/health", (req, res) => {
    res.json({ ok: true, connected: !!_db });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sync server running on http://0.0.0.0:${PORT}`);
    console.log(`Endpoint: GET http://127.0.0.1:${PORT}/api/codes`);
});
