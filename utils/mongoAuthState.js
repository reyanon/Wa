const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const fs = require("fs-extra");
const path = require("path");
const tar = require("tar");
const { connectDb } = require("./db");

const AUTH_DIR = "./auth_info";

async function useMongoAuthState() {
    const db = await connectDb();
    const coll = db.collection("auth");
    const session = await coll.findOne({ _id: "session" });

    if (session && session.archive) {
        const buffer = session.archive.buffer;
        await fs.writeFile("auth_info.tar", buffer);
        await tar.x({ file: "auth_info.tar", C: "." });
        await fs.remove("auth_info.tar");
    }

    const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(AUTH_DIR);

    async function saveCreds() {
        await originalSaveCreds();
        await tar.c({ file: "auth_info.tar", cwd: "." }, ["auth_info"]);
        const data = await fs.readFile("auth_info.tar");
        await coll.updateOne(
            { _id: "session" },
            { $set: { archive: data } },
            { upsert: true }
        );
        await fs.remove("auth_info.tar");
    }

    return { state, saveCreds };
}

module.exports = { useMongoAuthState };
