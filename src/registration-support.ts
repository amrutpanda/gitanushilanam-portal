import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export class ValidationError extends Error {}

export interface Env {
    gitanushilanam_db: D1Database;
    SCHOOL_QUIZ_UPLOADS: R2Bucket;
    TURNSTILE_SECRET_KEY: string;
    RESEND_API_KEY: string;
    REGISTRATION_DEADLINE: string;
}

interface TurnstileResult {
    success: boolean;
    hostname?: string;
    action?: string;
    "error-codes"?: string[];
}

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

export const allowedGenders = [
    "male",
    "female",
    "other",
    "prefer_not_to_say"
];

export const allowedParticipantGroups = [
    "sub_junior",
    "junior",
    "senior",
    "youth_adult"
];

export function readRequiredText(value: unknown, fieldName: string, maximumLength: number): string {
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

export function readOptionalText(value: unknown, fieldName: string, maximumLength: number): string | null {
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

export function readPhoneNumber(value: unknown, fieldName: string): string {
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

export function getCorsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("Origin");

    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

export function jsonResponse(
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

export function isAllowedOrigin(request: Request): boolean {
    const origin = request.headers.get("Origin");
    return origin !== null && allowedOrigins.includes(origin);
}

export async function verifyTurnstile(
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

