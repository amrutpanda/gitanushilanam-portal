import { parsePhoneNumberFromString } from "libphonenumber-js/max";

class ValidationError extends Error {}

interface Env {
    gitanushilanam_db: D1Database;
    TURNSTILE_SECRET_KEY: string;
}

interface TurnstileResult {
    success: boolean;
    hostname?: string;
    action?: string;
    "error-codes"?: string[];
}

interface AdminSession {
    session_id: number;
    admin_id: number;
    email: string;
    name: string | null;
    role: string;
    expires_at: number;
    active: number;
}

const ADMIN_SESSION_SECONDS = 60 * 60;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const ADMIN_PAGE_SIZE = 30;

const allowedOrigins = [
    "https://gitanushilanam.net",
    "https://www.gitanushilanam.net",
    "https://gitanushilanam.onrender.com",
    "http://127.0.0.1:5500",
    "http://localhost:5500"
];

const allowedTurnstileHostnames = [
    "gitanushilanam.net",
    "www.gitanushilanam.net",
    "gitanushilanam.onrender.com"
];

const allowedCompetitions = [
    "bhagavad_gita_quiz",
    "shloka_recitation",
    "animated_bg_video",
    "treasure_hunt"
];

const allowedGenders = [
    "male",
    "female",
    "other",
    "prefer_not_to_say"
];

const allowedParticipantGroups = [
    "sub_junior",
    "junior",
    "senior",
    "youth_adult"
];

const competitionColumns: Record<string, string> = {
    bhagavad_gita_quiz: "bhagavad_gita_quiz",
    shloka_recitation: "shloka_recitation",
    animated_bg_video: "animated_bg_video",
    treasure_hunt: "treasure_hunt"
};

function readRequiredText(value: unknown, fieldName: string, maximumLength: number): string {
    if (typeof value !== "string") {
        throw new ValidationError(fieldName + " must be text.");
    }

    const cleanedValue = value.trim();

    if (cleanedValue.length === 0) {
        throw new ValidationError(fieldName + " is required.");
    }

    if (Array.from(cleanedValue).length > maximumLength) {
        throw new ValidationError(fieldName + " must not exceed " + maximumLength + " characters.");
    }

    return cleanedValue;
}

function readOptionalText(value: unknown, fieldName: string, maximumLength: number): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value !== "string") {
        throw new ValidationError(fieldName + " must be text.");
    }

    const cleanedValue = value.trim();

    if (cleanedValue.length === 0) {
        return null;
    }

    if (Array.from(cleanedValue).length > maximumLength) {
        throw new ValidationError(fieldName + " must not exceed " + maximumLength + " characters.");
    }

    return cleanedValue;
}

function readPhoneNumber(value: unknown, fieldName: string): string {
    const text = readRequiredText(value, fieldName, 50);

    if (!text.startsWith("+")) {
        throw new ValidationError(fieldName + " must include a country code, such as +91.");
    }

    const parsedNumber = parsePhoneNumberFromString(text, { extract: false });

    if (parsedNumber === undefined || !parsedNumber.isValid()) {
        throw new ValidationError(fieldName + " is not a valid phone number.");
    }

    if (parsedNumber.ext !== undefined) {
        throw new ValidationError(fieldName + " must not include an extension.");
    }

    return parsedNumber.number;
}

function getCorsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("Origin");

    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Vary": "Origin",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
    };

    if (origin && allowedOrigins.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }

    return headers;
}

function jsonResponse(
    request: Request,
    data: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {}
): Response {
    return Response.json(data, {
        status,
        headers: {
            ...getCorsHeaders(request),
            ...extraHeaders
        }
    });
}

function isAllowedOrigin(request: Request): boolean {
    const origin = request.headers.get("Origin");
    return origin !== null && allowedOrigins.includes(origin);
}

function nowEpochSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function getBearerToken(request: Request): string | null {
    const authorization = request.headers.get("Authorization");

    if (!authorization) {
        return null;
    }

    const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/iu);
    return match ? match[1] : null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}

async function sha256Base64Url(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePasswordHash(
    password: string,
    saltBase64Url: string,
    iterations: number
): Promise<Uint8Array> {
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            hash: "SHA-256",
            salt: base64UrlToBytes(saltBase64Url),
            iterations
        },
        keyMaterial,
        256
    );

    return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
        return false;
    }

    let difference = 0;

    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }

    return difference === 0;
}

async function verifyPassword(
    password: string,
    saltBase64Url: string,
    expectedHashBase64Url: string,
    iterations: number
): Promise<boolean> {
    const actualHash = await derivePasswordHash(password, saltBase64Url, iterations);
    const expectedHash = base64UrlToBytes(expectedHashBase64Url);
    return constantTimeEqual(actualHash, expectedHash);
}

function generateSessionToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
}

function getClientIp(request: Request): string | null {
    const value = request.headers.get("CF-Connecting-IP");
    return value ? value.slice(0, 100) : null;
}

function getUserAgent(request: Request): string | null {
    const value = request.headers.get("User-Agent");
    return value ? value.slice(0, 500) : null;
}

async function writeLoginHistory(
    env: Env,
    request: Request,
    email: string,
    eventType: "login_success" | "login_failure" | "logout" | "session_expired",
    adminId: number | null,
    failureReason: string | null = null
): Promise<void> {
    await env.gitanushilanam_db.prepare(`
        INSERT INTO admin_login_history (
            admin_id,
            email_attempted,
            event_type,
            failure_reason,
            ip_address,
            user_agent
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
        adminId,
        email,
        eventType,
        failureReason,
        getClientIp(request),
        getUserAgent(request)
    ).run();
}

async function verifyTurnstile(
    token: string,
    request: Request,
    secretKey: string,
    expectedAction: string
): Promise<boolean> {
    try {
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                secret: secretKey,
                response: token,
                remoteip: request.headers.get("CF-Connecting-IP") ?? undefined
            })
        });

        if (!response.ok) {
            console.error("Turnstile Siteverify request failed with status:", response.status);
            return false;
        }

        const result = await response.json() as TurnstileResult;

        if (!result.success) {
            console.warn("Turnstile verification failed:", result["error-codes"]);
            return false;
        }

        if (result.action !== expectedAction) {
            console.warn("Unexpected Turnstile action:", result.action);
            return false;
        }

        if (!result.hostname || !allowedTurnstileHostnames.includes(result.hostname)) {
            console.warn("Unexpected Turnstile hostname:", result.hostname);
            return false;
        }

        return true;
    } catch (error) {
        console.error("Turnstile verification error:", error);
        return false;
    }
}

async function getAdminSession(request: Request, env: Env): Promise<AdminSession | null> {
    const token = getBearerToken(request);

    if (!token) {
        return null;
    }

    const sessionHash = await sha256Base64Url(token);
    const now = nowEpochSeconds();

    const session = await env.gitanushilanam_db.prepare(`
        SELECT
            s.id AS session_id,
            s.admin_id AS admin_id,
            s.expires_at AS expires_at,
            u.email AS email,
            u.name AS name,
            u.role AS role,
            u.active AS active
        FROM admin_sessions AS s
        INNER JOIN admin_accesslist AS u ON u.id = s.admin_id
        WHERE s.session_hash = ?
        LIMIT 1
    `).bind(sessionHash).first<AdminSession>();

    if (!session) {
        return null;
    }

    if (session.expires_at <= now || session.active !== 1) {
        await env.gitanushilanam_db.prepare(
            "DELETE FROM admin_sessions WHERE id = ?"
        ).bind(session.session_id).run();

        await writeLoginHistory(
            env,
            request,
            session.email,
            "session_expired",
            session.admin_id,
            session.active !== 1 ? "account_inactive" : "session_expired"
        );

        return null;
    }

    await env.gitanushilanam_db.prepare(
        "UPDATE admin_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(session.session_id).run();

    return session;
}

async function requireAdminSession(request: Request, env: Env): Promise<AdminSession | Response> {
    const session = await getAdminSession(request, env);

    if (!session) {
        return jsonResponse(request, {
            success: false,
            message: "Admin session is not valid. Please sign in again."
        }, 401);
    }

    return session;
}

const missingParticipantGroupCondition = `(
    participant_group IS NULL
    OR TRIM(participant_group) = ''
    OR participant_group NOT IN ('sub_junior', 'junior', 'senior', 'youth_adult')
)`;

const missingCountryCondition = `(
    country IS NULL
    OR TRIM(country) = ''
)`;

const missingStateCondition = `(
    state IS NULL
    OR TRIM(state) = ''
)`;

const missingCityCondition = `(
    city IS NULL
    OR TRIM(city) = ''
)`;

const needsReviewCondition = `(
    ${missingParticipantGroupCondition}
    OR ${missingCountryCondition}
    OR ${missingStateCondition}
    OR ${missingCityCondition}
)`;

async function requireSuperAdminSession(
    request: Request,
    env: Env
): Promise<AdminSession | Response> {
    const session = await requireAdminSession(request, env);

    if (session instanceof Response) {
        return session;
    }

    if (session.role !== "super_admin") {
        return jsonResponse(request, {
            success: false,
            message: "Super Admin access is required for this operation."
        }, 403);
    }

    return session;
}

function parseRegistrationId(value: string): number | null {
    if (!/^\d+$/u.test(value)) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSnapshotValue(value: unknown): unknown {
    return value === undefined ? null : value;
}

function getChangedSnapshots(
    oldSnapshot: Record<string, unknown>,
    newSnapshot: Record<string, unknown>
): {
    oldValues: Record<string, unknown>;
    newValues: Record<string, unknown>;
    changedFields: string[];
} {
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const changedFields: string[] = [];

    for (const key of Object.keys(newSnapshot)) {
        const oldValue = normalizeSnapshotValue(oldSnapshot[key]);
        const newValue = normalizeSnapshotValue(newSnapshot[key]);

        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
            oldValues[key] = oldValue;
            newValues[key] = newValue;
            changedFields.push(key);
        }
    }

    return {
        oldValues,
        newValues,
        changedFields
    };
}

async function getLoginAttemptKey(email: string, request: Request): Promise<string> {
    const ipAddress = getClientIp(request) ?? "unknown";
    return sha256Base64Url(`${email}|${ipAddress}`);
}

async function isLoginRateLimited(env: Env, attemptKey: string): Promise<boolean> {
    const now = nowEpochSeconds();

    const row = await env.gitanushilanam_db.prepare(`
        SELECT attempts, window_expires_at
        FROM admin_login_attempts
        WHERE attempt_key = ?
        LIMIT 1
    `).bind(attemptKey).first<{ attempts: number; window_expires_at: number }>();

    if (!row || row.window_expires_at <= now) {
        return false;
    }

    return row.attempts >= MAX_LOGIN_ATTEMPTS;
}

async function recordFailedLogin(env: Env, attemptKey: string): Promise<void> {
    const now = nowEpochSeconds();
    const nextExpiry = now + LOGIN_ATTEMPT_WINDOW_SECONDS;

    await env.gitanushilanam_db.prepare(`
        INSERT INTO admin_login_attempts (
            attempt_key,
            attempts,
            window_expires_at,
            last_attempt_at
        )
        VALUES (?, 1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(attempt_key) DO UPDATE SET
            attempts = CASE
                WHEN admin_login_attempts.window_expires_at <= ? THEN 1
                ELSE admin_login_attempts.attempts + 1
            END,
            window_expires_at = CASE
                WHEN admin_login_attempts.window_expires_at <= ? THEN ?
                ELSE admin_login_attempts.window_expires_at
            END,
            last_attempt_at = CURRENT_TIMESTAMP
    `).bind(
        attemptKey,
        nextExpiry,
        now,
        now,
        nextExpiry
    ).run();
}

async function clearLoginAttempts(env: Env, attemptKey: string): Promise<void> {
    await env.gitanushilanam_db.prepare(
        "DELETE FROM admin_login_attempts WHERE attempt_key = ?"
    ).bind(attemptKey).run();
}

function parsePositiveInteger(value: string | null, fallback: number): number {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed) || parsed < 1) {
        return fallback;
    }

    return parsed;
}

function normalizeFilter(value: string | null, maximumLength: number): string {
    if (!value) {
        return "";
    }

    return Array.from(value.trim()).slice(0, maximumLength).join("");
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        /* CORS PREFLIGHT */

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: getCorsHeaders(request)
            });
        }

        /* TEST ENDPOINT */

        if (url.pathname === "/api/test" && request.method === "GET") {
            return jsonResponse(request, {
                success: true,
                message: "Gitanushilanam API is working"
            });
        }

        /* =========================================================
           ADMIN AUTHENTICATION
        ========================================================== */

        if (url.pathname === "/api/admin/login" && request.method === "POST") {
            if (!isAllowedOrigin(request)) {
                return jsonResponse(request, {
                    success: false,
                    message: "Request origin is not allowed."
                }, 403);
            }

            try {
                let body: unknown;

                try {
                    body = await request.json();
                } catch {
                    throw new ValidationError("Please send valid JSON.");
                }

                if (typeof body !== "object" || body === null || Array.isArray(body)) {
                    throw new ValidationError("Login data must be a JSON object.");
                }

                const data = body as Record<string, unknown>;
                const email = readRequiredText(data.email, "Email", 254).toLowerCase();
                const password = readRequiredText(data.password, "Password", 256);
                const turnstileToken = readRequiredText(data.turnstile_token, "Security verification", 2048);

                const turnstileValid = await verifyTurnstile(
                    turnstileToken,
                    request,
                    env.TURNSTILE_SECRET_KEY,
                    "admin_login"
                );

                if (!turnstileValid) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Security verification failed. Please try again."
                    }, 403);
                }

                const attemptKey = await getLoginAttemptKey(email, request);

                if (await isLoginRateLimited(env, attemptKey)) {
                    await writeLoginHistory(
                        env,
                        request,
                        email,
                        "login_failure",
                        null,
                        "rate_limited"
                    );

                    return jsonResponse(request, {
                        success: false,
                        message: "Too many failed login attempts. Please try again after 15 minutes."
                    }, 429);
                }

                const admin = await env.gitanushilanam_db.prepare(`
                    SELECT
                        id,
                        email,
                        name,
                        role,
                        password_salt,
                        password_hash,
                        password_iterations
                    FROM admin_accesslist
                    WHERE email = ? COLLATE NOCASE
                      AND active = 1
                    LIMIT 1
                `).bind(email).first<{
                    id: number;
                    email: string;
                    name: string | null;
                    role: string;
                    password_salt: string | null;
                    password_hash: string | null;
                    password_iterations: number;
                }>();

                let passwordValid = false;

                if (admin?.password_salt && admin.password_hash) {
                    passwordValid = await verifyPassword(
                        password,
                        admin.password_salt,
                        admin.password_hash,
                        admin.password_iterations
                    );
                } else {
                    await derivePasswordHash(password, "AAAAAAAAAAAAAAAAAAAAAA", 100000);
                }

                if (!admin || !passwordValid) {
                    await recordFailedLogin(env, attemptKey);
                    await writeLoginHistory(
                        env,
                        request,
                        email,
                        "login_failure",
                        admin?.id ?? null,
                        "invalid_credentials"
                    );

                    return jsonResponse(request, {
                        success: false,
                        message: "Invalid email or password."
                    }, 401);
                }

                await clearLoginAttempts(env, attemptKey);

                const expiresAt = nowEpochSeconds() + ADMIN_SESSION_SECONDS;
                const sessionToken = generateSessionToken();
                const sessionHash = await sha256Base64Url(sessionToken);

                await env.gitanushilanam_db.batch([
                    env.gitanushilanam_db.prepare(
                        "DELETE FROM admin_sessions WHERE admin_id = ?"
                    ).bind(admin.id),
                    env.gitanushilanam_db.prepare(`
                        INSERT INTO admin_sessions (admin_id, session_hash, expires_at, last_seen_at)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    `).bind(admin.id, sessionHash, expiresAt),
                    env.gitanushilanam_db.prepare(`
                        UPDATE admin_accesslist
                        SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).bind(admin.id)
                ]);

                await writeLoginHistory(
                    env,
                    request,
                    admin.email,
                    "login_success",
                    admin.id
                );

                return jsonResponse(request, {
                    success: true,
                    admin: {
                        email: admin.email,
                        name: admin.name,
                        role: admin.role
                    },
                    session_token: sessionToken,
                    expires_at: expiresAt
                });
            } catch (error) {
                if (error instanceof ValidationError) {
                    return jsonResponse(request, {
                        success: false,
                        message: error.message
                    }, 400);
                }

                console.error("Admin login error:", error);

                return jsonResponse(request, {
                    success: false,
                    message: "Unable to sign in."
                }, 500);
            }
        }

        if (url.pathname === "/api/admin/logout" && request.method === "POST") {
            if (!isAllowedOrigin(request)) {
                return jsonResponse(request, {
                    success: false,
                    message: "Request origin is not allowed."
                }, 403);
            }

            const session = await getAdminSession(request, env);

            if (session) {
                await env.gitanushilanam_db.prepare(
                    "DELETE FROM admin_sessions WHERE id = ?"
                ).bind(session.session_id).run();

                await writeLoginHistory(
                    env,
                    request,
                    session.email,
                    "logout",
                    session.admin_id
                );
            }

            return jsonResponse(request, {
                success: true
            });
        }

        if (url.pathname === "/api/admin/session" && request.method === "GET") {
            const session = await getAdminSession(request, env);

            if (!session) {
                return jsonResponse(request, {
                    success: false,
                    message: "No active admin session."
                }, 401);
            }

            return jsonResponse(request, {
                success: true,
                admin: {
                    email: session.email,
                    name: session.name,
                    role: session.role
                },
                expires_at: session.expires_at
            });
        }

        /* =========================================================
           ADMIN DASHBOARD API

           Normal admins remain read-only.
           Super Admin can correct registration data.
           There are intentionally no registration/admin delete
           endpoints in this web API.
        ========================================================== */

        if (url.pathname === "/admin/api/summary" && request.method === "GET") {
            const session = await requireAdminSession(request, env);

            if (session instanceof Response) {
                return session;
            }

            const summary = await env.gitanushilanam_db.prepare(`
                SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(bhagavad_gita_quiz), 0) AS quiz,
                    COALESCE(SUM(shloka_recitation), 0) AS shloka_recitation,
                    COALESCE(SUM(animated_bg_video), 0) AS animated_bg_video,
                    COALESCE(SUM(treasure_hunt), 0) AS treasure_hunt
                FROM registrations
            `).first<{
                total: number;
                quiz: number;
                shloka_recitation: number;
                animated_bg_video: number;
                treasure_hunt: number;
            }>();

            const participantGroups = await env.gitanushilanam_db.prepare(`
                SELECT
                    COALESCE(SUM(CASE WHEN participant_group = 'sub_junior' THEN 1 ELSE 0 END), 0) AS sub_junior,
                    COALESCE(SUM(CASE WHEN participant_group = 'junior' THEN 1 ELSE 0 END), 0) AS junior,
                    COALESCE(SUM(CASE WHEN participant_group = 'senior' THEN 1 ELSE 0 END), 0) AS senior,
                    COALESCE(SUM(CASE WHEN participant_group = 'youth_adult' THEN 1 ELSE 0 END), 0) AS youth_adult,
                    COALESCE(SUM(CASE WHEN ${missingParticipantGroupCondition} THEN 1 ELSE 0 END), 0) AS unassigned
                FROM registrations
            `).first<{
                sub_junior: number;
                junior: number;
                senior: number;
                youth_adult: number;
                unassigned: number;
            }>();

            const review = await env.gitanushilanam_db.prepare(`
                SELECT
                    COALESCE(SUM(CASE WHEN ${needsReviewCondition} THEN 1 ELSE 0 END), 0) AS needs_review,
                    COALESCE(SUM(CASE WHEN ${missingParticipantGroupCondition} THEN 1 ELSE 0 END), 0) AS missing_participant_group,
                    COALESCE(SUM(CASE WHEN ${missingCountryCondition} THEN 1 ELSE 0 END), 0) AS missing_country,
                    COALESCE(SUM(CASE WHEN ${missingStateCondition} THEN 1 ELSE 0 END), 0) AS missing_state,
                    COALESCE(SUM(CASE WHEN ${missingCityCondition} THEN 1 ELSE 0 END), 0) AS missing_city,
                    COALESCE(SUM(CASE WHEN NOT ${needsReviewCondition} THEN 1 ELSE 0 END), 0) AS complete
                FROM registrations
            `).first<{
                needs_review: number;
                missing_participant_group: number;
                missing_country: number;
                missing_state: number;
                missing_city: number;
                complete: number;
            }>();

            const dailyRows = await env.gitanushilanam_db.prepare(`
                SELECT
                    DATE(created_at) AS date,
                    COUNT(*) AS count
                FROM registrations
                WHERE DATE(created_at) >= DATE('now', '-29 days')
                GROUP BY DATE(created_at)
                ORDER BY DATE(created_at)
            `).all<{ date: string; count: number }>();

            const dailyMap = new Map<string, number>();

            for (const row of dailyRows.results) {
                dailyMap.set(row.date, Number(row.count) || 0);
            }

            const dailyRegistrations: Array<{ date: string; count: number }> = [];
            const today = new Date();

            for (let offset = 29; offset >= 0; offset -= 1) {
                const date = new Date(Date.UTC(
                    today.getUTCFullYear(),
                    today.getUTCMonth(),
                    today.getUTCDate() - offset
                ));

                const key = date.toISOString().slice(0, 10);
                dailyRegistrations.push({
                    date: key,
                    count: dailyMap.get(key) ?? 0
                });
            }

            return jsonResponse(request, {
                success: true,
                summary: summary ?? {
                    total: 0,
                    quiz: 0,
                    shloka_recitation: 0,
                    animated_bg_video: 0,
                    treasure_hunt: 0
                },
                participant_groups: participantGroups ?? {
                    sub_junior: 0,
                    junior: 0,
                    senior: 0,
                    youth_adult: 0,
                    unassigned: 0
                },
                review: review ?? {
                    needs_review: 0,
                    missing_participant_group: 0,
                    missing_country: 0,
                    missing_state: 0,
                    missing_city: 0,
                    complete: 0
                },
                daily_registrations: dailyRegistrations
            });
        }

        if (url.pathname === "/admin/api/filter-options" && request.method === "GET") {
            const session = await requireAdminSession(request, env);

            if (session instanceof Response) {
                return session;
            }

            const [countryResult, stateResult] = await env.gitanushilanam_db.batch([
                env.gitanushilanam_db.prepare(`
                    SELECT DISTINCT country
                    FROM registrations
                    WHERE country IS NOT NULL AND TRIM(country) <> ''
                    ORDER BY country COLLATE NOCASE
                    LIMIT 250
                `),
                env.gitanushilanam_db.prepare(`
                    SELECT DISTINCT state
                    FROM registrations
                    WHERE state IS NOT NULL AND TRIM(state) <> ''
                    ORDER BY state COLLATE NOCASE
                    LIMIT 500
                `)
            ]);

            const countries = (countryResult.results as Array<{ country: string }>).map(
                row => row.country
            );
            const states = (stateResult.results as Array<{ state: string }>).map(
                row => row.state
            );

            return jsonResponse(request, {
                success: true,
                countries,
                states
            });
        }

        if (url.pathname === "/admin/api/admins" && request.method === "GET") {
            const session = await requireSuperAdminSession(request, env);

            if (session instanceof Response) {
                return session;
            }

            const rows = await env.gitanushilanam_db.prepare(`
                SELECT
                    id,
                    email,
                    name,
                    role,
                    active,
                    CASE
                        WHEN password_hash IS NOT NULL AND password_salt IS NOT NULL THEN 1
                        ELSE 0
                    END AS password_set,
                    password_changed_at,
                    last_login_at,
                    created_at,
                    updated_at
                FROM admin_accesslist
                ORDER BY
                    CASE WHEN role = 'super_admin' THEN 0 ELSE 1 END,
                    name COLLATE NOCASE,
                    email COLLATE NOCASE
            `).all();

            return jsonResponse(request, {
                success: true,
                admins: rows.results
            });
        }

        if (url.pathname === "/admin/api/audit-log" && request.method === "GET") {
            const session = await requireSuperAdminSession(request, env);

            if (session instanceof Response) {
                return session;
            }

            const requestedPage = parsePositiveInteger(url.searchParams.get("page"), 1);
            const requestedPageSize = parsePositiveInteger(url.searchParams.get("page_size"), 50);
            const pageSize = Math.min(requestedPageSize, 100);

            const countRow = await env.gitanushilanam_db.prepare(`
                SELECT COUNT(*) AS total
                FROM admin_audit_log
            `).first<{ total: number }>();

            const total = countRow?.total ?? 0;
            const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
            const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
            const offset = (page - 1) * pageSize;

            const rows = await env.gitanushilanam_db.prepare(`
                SELECT
                    id,
                    admin_id,
                    admin_email,
                    admin_role,
                    action,
                    entity_type,
                    entity_id,
                    old_values,
                    new_values,
                    ip_address,
                    created_at
                FROM admin_audit_log
                ORDER BY id DESC
                LIMIT ? OFFSET ?
            `).bind(pageSize, offset).all();

            return jsonResponse(request, {
                success: true,
                page,
                page_size: pageSize,
                total,
                total_pages: totalPages,
                entries: rows.results
            });
        }

        if (url.pathname === "/admin/api/registrations" && request.method === "GET") {
            const session = await requireAdminSession(request, env);

            if (session instanceof Response) {
                return session;
            }

            const requestedPage = parsePositiveInteger(url.searchParams.get("page"), 1);
            const requestedPageSize = parsePositiveInteger(
                url.searchParams.get("page_size"),
                ADMIN_PAGE_SIZE
            );
            const pageSize = Math.min(requestedPageSize, ADMIN_PAGE_SIZE);

            const search = normalizeFilter(url.searchParams.get("search"), 100);
            const competition = normalizeFilter(url.searchParams.get("competition"), 50);
            const participantGroup = normalizeFilter(
                url.searchParams.get("participant_group"),
                50
            );
            const country = normalizeFilter(url.searchParams.get("country"), 100);
            const state = normalizeFilter(url.searchParams.get("state"), 100);
            const reviewStatus = normalizeFilter(url.searchParams.get("review"), 50);

            const conditions: string[] = [];
            const bindings: Array<string | number> = [];

            if (search) {
                const pattern = `%${search.toLowerCase()}%`;

                conditions.push(`(
                    LOWER(name) LIKE ?
                    OR LOWER(email) LIKE ?
                    OR LOWER(phone) LIKE ?
                    OR LOWER(whatsapp) LIKE ?
                )`);

                bindings.push(pattern, pattern, pattern, pattern);
            }

            if (competition) {
                const competitionColumn = competitionColumns[competition];

                if (!competitionColumn) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Invalid competition filter."
                    }, 400);
                }

                conditions.push(`${competitionColumn} = 1`);
            }

            if (participantGroup) {
                if (!allowedParticipantGroups.includes(participantGroup)) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Invalid participant group filter."
                    }, 400);
                }

                conditions.push("participant_group = ?");
                bindings.push(participantGroup);
            }

            if (country) {
                conditions.push("LOWER(country) = LOWER(?)");
                bindings.push(country);
            }

            if (state) {
                conditions.push("LOWER(state) = LOWER(?)");
                bindings.push(state);
            }

            if (reviewStatus) {
                if (reviewStatus === "needs_review") {
                    conditions.push(needsReviewCondition);
                } else if (reviewStatus === "complete") {
                    conditions.push(`NOT ${needsReviewCondition}`);
                } else if (reviewStatus === "missing_participant_group") {
                    conditions.push(missingParticipantGroupCondition);
                } else if (reviewStatus === "missing_country") {
                    conditions.push(missingCountryCondition);
                } else if (reviewStatus === "missing_state") {
                    conditions.push(missingStateCondition);
                } else if (reviewStatus === "missing_city") {
                    conditions.push(missingCityCondition);
                } else {
                    return jsonResponse(request, {
                        success: false,
                        message: "Invalid data review filter."
                    }, 400);
                }
            }

            const whereClause = conditions.length > 0
                ? `WHERE ${conditions.join(" AND ")}`
                : "";

            const countRow = await env.gitanushilanam_db.prepare(`
                SELECT COUNT(*) AS total
                FROM registrations
                ${whereClause}
            `).bind(...bindings).first<{ total: number }>();

            const total = countRow?.total ?? 0;
            const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
            const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
            const offset = (page - 1) * pageSize;

            const rows = await env.gitanushilanam_db.prepare(`
                SELECT
                    id,
                    name,
                    email,
                    phone,
                    whatsapp,
                    age,
                    participant_group,
                    gender,
                    institution_organization,
                    country,
                    state,
                    city,
                    heard_from,
                    bhagavad_gita_quiz,
                    shloka_recitation,
                    animated_bg_video,
                    treasure_hunt,
                    created_at,
                    CASE WHEN ${needsReviewCondition} THEN 1 ELSE 0 END AS needs_review
                FROM registrations
                ${whereClause}
                ORDER BY id DESC
                LIMIT ? OFFSET ?
            `).bind(...bindings, pageSize, offset).all();

            return jsonResponse(request, {
                success: true,
                page,
                page_size: pageSize,
                total,
                total_pages: totalPages,
                registrations: rows.results
            });
        }

        const registrationUpdateMatch = url.pathname.match(
            /^\/admin\/api\/registrations\/(\d+)$/u
        );

        if (registrationUpdateMatch && request.method === "PATCH") {
            if (!isAllowedOrigin(request)) {
                return jsonResponse(request, {
                    success: false,
                    message: "Request origin is not allowed."
                }, 403);
            }

            const session = await requireSuperAdminSession(request, env);

            if (session instanceof Response) {
                return session;
            }

            const registrationId = parseRegistrationId(registrationUpdateMatch[1]);

            if (!registrationId) {
                return jsonResponse(request, {
                    success: false,
                    message: "Invalid registration ID."
                }, 400);
            }

            try {
                let body: unknown;

                try {
                    body = await request.json();
                } catch {
                    throw new ValidationError("Please send valid JSON.");
                }

                if (typeof body !== "object" || body === null || Array.isArray(body)) {
                    throw new ValidationError("Registration data must be a JSON object.");
                }

                const data = body as Record<string, unknown>;
                const name = readRequiredText(data.name, "Name", 100);
                const email = readRequiredText(data.email, "Email", 254).toLowerCase();
                const phone = readPhoneNumber(data.phone, "Phone number");
                const whatsapp = readPhoneNumber(data.whatsapp, "WhatsApp number");
                const gender = readRequiredText(data.gender, "Gender", 30);

                if (!allowedGenders.includes(gender)) {
                    throw new ValidationError("Please select a valid gender.");
                }

                const institutionOrganization = readOptionalText(
                    data.institution_organization,
                    "School / Institute / Organization",
                    200
                );

                const country = readRequiredText(data.country, "Country", 100);
                const state = readRequiredText(data.state, "State", 100);
                const city = readRequiredText(data.city, "City", 100);
                const heardFrom = readRequiredText(
                    data.heard_from,
                    "How participant heard about us",
                    200
                );

                if (typeof data.age !== "number") {
                    throw new ValidationError("Age must be a number.");
                }

                const age = data.age;

                if (!Number.isInteger(age) || age < 3 || age > 120) {
                    throw new ValidationError("Please enter a valid age.");
                }

                const participantGroup = readRequiredText(
                    data.participant_group,
                    "Participant group",
                    30
                );

                if (!allowedParticipantGroups.includes(participantGroup)) {
                    throw new ValidationError("Please select a valid participant group.");
                }

                if (!Array.isArray(data.competitions)) {
                    throw new ValidationError("Please select at least one competition.");
                }

                const competitions: string[] = [];

                for (const competition of data.competitions) {
                    if (typeof competition !== "string") {
                        throw new ValidationError("Each competition must be text.");
                    }

                    if (!allowedCompetitions.includes(competition)) {
                        throw new ValidationError("Invalid competition selected.");
                    }

                    if (!competitions.includes(competition)) {
                        competitions.push(competition);
                    }
                }

                if (competitions.length === 0) {
                    throw new ValidationError("Please select at least one competition.");
                }

                const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

                if (!emailPattern.test(email)) {
                    throw new ValidationError("Please enter a valid email address.");
                }

                const existing = await env.gitanushilanam_db.prepare(`
                    SELECT
                        id,
                        name,
                        email,
                        phone,
                        whatsapp,
                        age,
                        participant_group,
                        gender,
                        institution_organization,
                        country,
                        state,
                        city,
                        heard_from,
                        bhagavad_gita_quiz,
                        shloka_recitation,
                        animated_bg_video,
                        treasure_hunt,
                        created_at
                    FROM registrations
                    WHERE id = ?
                    LIMIT 1
                `).bind(registrationId).first<Record<string, unknown>>();

                if (!existing) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Registration not found."
                    }, 404);
                }

                const duplicate = await env.gitanushilanam_db.prepare(`
                    SELECT id
                    FROM registrations
                    WHERE id <> ?
                      AND (
                          LOWER(email) = LOWER(?)
                          OR phone = ?
                      )
                    LIMIT 1
                `).bind(registrationId, email, phone).first<{ id: number }>();

                if (duplicate) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Another registration already uses this email or phone number."
                    }, 409);
                }

                const bhagavadGitaQuiz = competitions.includes("bhagavad_gita_quiz") ? 1 : 0;
                const shlokaRecitation = competitions.includes("shloka_recitation") ? 1 : 0;
                const animatedBgVideo = competitions.includes("animated_bg_video") ? 1 : 0;
                const treasureHunt = competitions.includes("treasure_hunt") ? 1 : 0;

                const oldSnapshot: Record<string, unknown> = {
                    name: existing.name,
                    email: existing.email,
                    phone: existing.phone,
                    whatsapp: existing.whatsapp,
                    age: existing.age,
                    participant_group: existing.participant_group,
                    gender: existing.gender,
                    institution_organization: existing.institution_organization,
                    country: existing.country,
                    state: existing.state,
                    city: existing.city,
                    heard_from: existing.heard_from,
                    bhagavad_gita_quiz: existing.bhagavad_gita_quiz,
                    shloka_recitation: existing.shloka_recitation,
                    animated_bg_video: existing.animated_bg_video,
                    treasure_hunt: existing.treasure_hunt
                };

                const newSnapshot: Record<string, unknown> = {
                    name,
                    email,
                    phone,
                    whatsapp,
                    age,
                    participant_group: participantGroup,
                    gender,
                    institution_organization: institutionOrganization,
                    country,
                    state,
                    city,
                    heard_from: heardFrom,
                    bhagavad_gita_quiz: bhagavadGitaQuiz,
                    shloka_recitation: shlokaRecitation,
                    animated_bg_video: animatedBgVideo,
                    treasure_hunt: treasureHunt
                };

                const changes = getChangedSnapshots(oldSnapshot, newSnapshot);

                if (changes.changedFields.length === 0) {
                    return jsonResponse(request, {
                        success: true,
                        no_changes: true,
                        changed_fields: []
                    });
                }

                const updateStatement = env.gitanushilanam_db.prepare(`
                    UPDATE registrations
                    SET
                        name = ?,
                        email = ?,
                        phone = ?,
                        whatsapp = ?,
                        age = ?,
                        participant_group = ?,
                        gender = ?,
                        institution_organization = ?,
                        country = ?,
                        state = ?,
                        city = ?,
                        heard_from = ?,
                        bhagavad_gita_quiz = ?,
                        shloka_recitation = ?,
                        animated_bg_video = ?,
                        treasure_hunt = ?
                    WHERE id = ?
                `).bind(
                    name,
                    email,
                    phone,
                    whatsapp,
                    age,
                    participantGroup,
                    gender,
                    institutionOrganization,
                    country,
                    state,
                    city,
                    heardFrom,
                    bhagavadGitaQuiz,
                    shlokaRecitation,
                    animatedBgVideo,
                    treasureHunt,
                    registrationId
                );

                const auditStatement = env.gitanushilanam_db.prepare(`
                    INSERT INTO admin_audit_log (
                        admin_id,
                        admin_email,
                        admin_role,
                        action,
                        entity_type,
                        entity_id,
                        old_values,
                        new_values,
                        ip_address,
                        user_agent
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    session.admin_id,
                    session.email,
                    session.role,
                    "registration_update",
                    "registration",
                    String(registrationId),
                    JSON.stringify(changes.oldValues),
                    JSON.stringify(changes.newValues),
                    getClientIp(request),
                    getUserAgent(request)
                );

                await env.gitanushilanam_db.batch([
                    updateStatement,
                    auditStatement
                ]);

                return jsonResponse(request, {
                    success: true,
                    no_changes: false,
                    changed_fields: changes.changedFields
                });
            } catch (error) {
                if (error instanceof ValidationError) {
                    return jsonResponse(request, {
                        success: false,
                        message: error.message
                    }, 400);
                }

                console.error("Super Admin registration update error:", error);

                return jsonResponse(request, {
                    success: false,
                    message: "Unable to update the registration."
                }, 500);
            }
        }

        /* =========================================================
           EXISTING PUBLIC REGISTRATION ENDPOINT
        ========================================================== */

        if (url.pathname === "/api/register" && request.method === "POST") {
            try {
                let body: unknown;

                try {
                    body = await request.json();
                } catch {
                    throw new ValidationError("Please send valid JSON.");
                }

                if (typeof body !== "object" || body === null || Array.isArray(body)) {
                    throw new ValidationError("Registration data must be a JSON object.");
                }

                const data = body as Record<string, unknown>;

                /* TURNSTILE SECURITY VERIFICATION */

                const turnstileToken = readRequiredText(
                    data.turnstile_token,
                    "Security verification",
                    2048
                );

                const turnstileValid = await verifyTurnstile(
                    turnstileToken,
                    request,
                    env.TURNSTILE_SECRET_KEY,
                    "registration"
                );

                if (!turnstileValid) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Security verification failed. Please try again."
                    }, 403);
                }

                /* BASIC DETAILS */

                const name = readRequiredText(data.name, "Name", 100);
                const email = readRequiredText(data.email, "Email", 254).toLowerCase();
                const phone = readPhoneNumber(data.phone, "Phone number");
                const whatsapp = readPhoneNumber(data.whatsapp, "WhatsApp number");

                /* GENDER */

                const gender = readRequiredText(data.gender, "Gender", 30);

                if (!allowedGenders.includes(gender)) {
                    throw new ValidationError("Please select a valid gender.");
                }

                /* SCHOOL / INSTITUTE / ORGANIZATION - OPTIONAL */

                const institutionOrganization = readOptionalText(
                    data.institution_organization,
                    "School / Institute / Organization",
                    200
                );

                /* LOCATION */

                const country = readRequiredText(data.country, "Country", 100);
                const state = readRequiredText(data.state, "State", 100);
                const city = readRequiredText(data.city, "City", 100);

                /* HOW PARTICIPANT HEARD ABOUT COMPETITION */

                const heardFrom = readRequiredText(
                    data.heard_from,
                    "How you heard about us",
                    200
                );

                /* AGE */

                if (typeof data.age !== "number") {
                    throw new ValidationError("Age must be a number.");
                }

                const age = data.age;

                if (!Number.isInteger(age) || age < 3 || age > 120) {
                    throw new ValidationError("Please enter a valid age.");
                }

                /* PARTICIPANT GROUP */

                const participantGroup = readRequiredText(
                    data.participant_group,
                    "Participant group",
                    30
                );

                if (!allowedParticipantGroups.includes(participantGroup)) {
                    throw new ValidationError("Please select a valid participant group.");
                }

                /* COMPETITIONS */

                if (!Array.isArray(data.competitions)) {
                    throw new ValidationError("Please select at least one competition.");
                }

                const competitions: string[] = [];

                for (const competition of data.competitions) {
                    if (typeof competition !== "string") {
                        throw new ValidationError("Each competition must be text.");
                    }

                    competitions.push(competition);
                }

                /* EMAIL VALIDATION */

                const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (!emailPattern.test(email)) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Please enter a valid email address."
                    }, 400);
                }

                /* COMPETITION VALIDATION */

                if (competitions.length === 0) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Please select at least one competition."
                    }, 400);
                }

                const invalidCompetition = competitions.some(
                    competition => !allowedCompetitions.includes(competition)
                );

                if (invalidCompetition) {
                    return jsonResponse(request, {
                        success: false,
                        message: "Invalid competition selected."
                    }, 400);
                }

                /* CONVERT COMPETITIONS TO DATABASE FLAGS */

                const bhagavadGitaQuiz = competitions.includes("bhagavad_gita_quiz") ? 1 : 0;
                const shlokaRecitation = competitions.includes("shloka_recitation") ? 1 : 0;
                const animatedBgVideo = competitions.includes("animated_bg_video") ? 1 : 0;
                const treasureHunt = competitions.includes("treasure_hunt") ? 1 : 0;

                /* INSERT REGISTRATION */

                const result = await env.gitanushilanam_db.prepare(`
                    INSERT OR IGNORE INTO registrations (
                        name,
                        email,
                        phone,
                        whatsapp,
                        age,
                        participant_group,
                        gender,
                        institution_organization,
                        country,
                        state,
                        city,
                        heard_from,
                        bhagavad_gita_quiz,
                        shloka_recitation,
                        animated_bg_video,
                        treasure_hunt
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    name,
                    email,
                    phone,
                    whatsapp,
                    age,
                    participantGroup,
                    gender,
                    institutionOrganization,
                    country,
                    state,
                    city,
                    heardFrom,
                    bhagavadGitaQuiz,
                    shlokaRecitation,
                    animatedBgVideo,
                    treasureHunt
                ).run();

                /* DUPLICATE REGISTRATION */

                if (result.meta.changes === 0) {
                    return jsonResponse(request, {
                        success: false,
                        message: "A registration already exists with this email or phone number."
                    }, 409);
                }

                /* SUCCESS */

                return jsonResponse(request, {
                    success: true,
                    message: "Registration successful."
                });
            } catch (error) {
                if (error instanceof ValidationError) {
                    return jsonResponse(request, {
                        success: false,
                        message: error.message
                    }, 400);
                }

                console.error("Registration error:", error);

                return jsonResponse(request, {
                    success: false,
                    message: "Unable to process the registration."
                }, 500);
            }
        }

        /* NOT FOUND */

        return jsonResponse(request, {
            success: false,
            message: "Not Found"
        }, 404);
    }
} satisfies ExportedHandler<Env>;
