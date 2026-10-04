import crypto from "node:crypto";
import readline from "node:readline";

const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

function askText(questionText) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(questionText, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function askHidden(questionText) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
            reject(new Error("Hidden password input requires an interactive terminal."));
            return;
        }

        process.stdout.write(questionText);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        let value = "";

        function cleanup() {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
        }

        function onData(character) {
            if (character === "\r" || character === "\n") {
                cleanup();
                process.stdout.write("\n");
                resolve(value);
                return;
            }

            if (character === "\u0003") {
                cleanup();
                process.stdout.write("\n");
                process.exit(130);
            }

            if (character === "\u007f") {
                if (value.length > 0) {
                    value = value.slice(0, -1);
                    process.stdout.write("\b \b");
                }
                return;
            }

            value += character;
            process.stdout.write("*");
        }

        process.stdin.on("data", onData);
    });
}

function escapeSql(value) {
    return value.replaceAll("'", "''");
}

const email = (await askText("Existing admin email: ")).toLowerCase();
const password = await askHidden("New admin password: ");

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Please enter a valid email address.");
}

if (password.length < 10) {
    throw new Error("Use a password of at least 10 characters.");
}

const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
const saltValue = salt.toString("base64url");
const hashValue = hash.toString("base64url");

console.log("\nRun this SQL against the remote D1 database:\n");
console.log(
    `UPDATE admin_accesslist SET password_salt = '${saltValue}', password_hash = '${hashValue}', password_iterations = ${ITERATIONS}, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE email = '${escapeSql(email)}' COLLATE NOCASE;`
);
console.log("\nThen verify that one row was updated for the expected admin email.");
console.log("The plain-text password was not written to disk.");
