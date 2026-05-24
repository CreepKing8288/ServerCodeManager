// Run ONCE to export MongoDB codes as JSON for the behavior pack.
// Usage:
//   1. $env:MONGODB_URI='mongodb+srv://...'
//   2. node import-codes.js > codes-export.json
//   3. Open Minecraft world, run: /scriptevent seconfig:import <paste JSON>

const { MongoClient, ServerApiVersion } = require("mongodb");

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("Set MONGODB_URI env var"); process.exit(1); }

(async () => {
    const client = new MongoClient(uri, {
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
    });
    await client.connect();
    const db = client.db("servercodes");
    const codes = await db.collection("codes").find({}).toArray();
    const output = codes.map(c => ({
        code: c.code,
        type: c.type || "monthly",
        gamertag: c.gamertag || "import",
        createdAt: c.createdAt || new Date().toISOString(),
        expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : Date.now() + 30 * 24 * 60 * 60 * 1000,
        uses: c.uses !== undefined ? c.uses : null,
        active: c.active !== false
    }));
    console.log(JSON.stringify(output));
    await client.close();
})();
