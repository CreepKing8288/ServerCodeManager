const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { MongoClient, ServerApiVersion } = require("mongodb");
const crypto = require("crypto");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const ROLE_MONTHLY = "1506494998093365359";
const ROLE_TEMP = "1507436459051712662";
const ROLE_ADMIN = "1507454856724484176";

if (!TOKEN || !GUILD_ID) {
    console.error("Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID environment variables");
    process.exit(1);
}

let _db;
async function getDB() {
    if (!_db) {
        const client = new MongoClient(process.env.MONGODB_URI, {
            serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
        });
        await client.connect();
        _db = client.db("servercodes");
    }
    return _db;
}

function genCode() {
    return crypto.randomBytes(3).toString("hex").toUpperCase();
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const commands = [
    new SlashCommandBuilder()
        .setName("generate")
        .setDescription("Generate a server code")
        .addSubcommand(sub =>
            sub.setName("code").setDescription("Generate a monthly code")
                .addStringOption(opt =>
                    opt.setName("gamertag").setDescription("Your Minecraft gamertag").setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName("temporarycode").setDescription("Generate a one-time temporary code")
                .addStringOption(opt =>
                    opt.setName("gamertag").setDescription("Your Minecraft gamertag").setRequired(true)
                )
        )
];

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
            body: commands.map(c => c.toJSON()),
        });
        console.log("Slash commands registered");
    } catch (e) {
        console.error("Failed to register commands:", e);
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "generate") return;

    const sub = interaction.options.getSubcommand();
    const member = interaction.member;
    const gamertag = interaction.options.getString("gamertag");

    async function setNickname() {
        try {
            if (member.manageable) {
                await member.setNickname(gamertag);
            }
        } catch (e) {
            console.warn(`Could not set nickname for ${interaction.user.tag}: ${e.message}`);
        }
    }

    async function findExisting(type) {
        const db = await getDB();
        const now = Date.now();
        return db.collection("codes").findOne({
            discordId: interaction.user.id,
            type,
            expiresAt: { $gt: now },
            expiredByLeave: false,
            ...(type === "temporary" ? { uses: { $gt: 0 } } : {})
        });
    }

    if (sub === "code") {
        if (!member.roles.cache.has(ROLE_MONTHLY) && !member.roles.cache.has(ROLE_ADMIN)) {
            return interaction.reply({
                content: `You need at least one of the required roles to use this command.`,
                ephemeral: true
            });
        }

        const existing = await findExisting("monthly");
        if (existing) {
            await setNickname();
            return interaction.reply({
                content: `You already have an active code: \`${existing.code}\`\nValid for ${existing.months} month(s).`,
                ephemeral: true
            });
        }

        const code = genCode();
        const months = 1;
        const db = await getDB();
        await db.collection("codes").insertOne({
            code,
            type: "monthly",
            discordId: interaction.user.id,
            gamertag,
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + months * 30 * 24 * 60 * 60 * 1000,
            months,
            uses: null,
            expiredByLeave: false
        });

        await setNickname();

        return interaction.reply({
            content: `Monthly code generated: \`${code}\`\nValid for ${months} month(s).`,
            ephemeral: true
        });
    }

    if (sub === "temporarycode") {
        if (!member.roles.cache.has(ROLE_TEMP) && !member.roles.cache.has(ROLE_ADMIN)) {
            return interaction.reply({
                content: `You need the <@&${ROLE_TEMP}> role to use this command.`,
                ephemeral: true
            });
        }

        const existing = await findExisting("temporary");
        if (existing) {
            await setNickname();
            return interaction.reply({
                content: `You already have an active temporary code: \`${existing.code}\`\nIt expires if you leave the server.`,
                ephemeral: true
            });
        }

        const code = genCode();
        const db = await getDB();
        await db.collection("codes").insertOne({
            code,
            type: "temporary",
            discordId: interaction.user.id,
            gamertag,
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            uses: 1,
            redeemed: false,
            expiredByLeave: false
        });

        await setNickname();

        return interaction.reply({
            content: `Temporary code generated: \`${code}\`\nThis code can only be used once and expires in 24 hours. It also expires if you leave the server.`,
            ephemeral: true
        });
    }
});

client.on("guildMemberRemove", async (member) => {
    try {
        const db = await getDB();
        const result = await db.collection("codes").updateMany(
            { discordId: member.id, expiredByLeave: false },
            { $set: { expiredByLeave: true, expiredAtLeave: new Date().toISOString() } }
        );
        if (result.modifiedCount > 0) {
            console.log(`Expired ${result.modifiedCount} code(s) for user ${member.id} (${member.user?.tag || "unknown"})`);
        }
    } catch (e) {
        console.error(`Error expiring codes for user ${member.id}:`, e);
    }
});

client.login(TOKEN);
