import { parsePhoneNumberFromString } from "libphonenumber-js/max";

class ValidationError extends Error {}

function readRequiredText(value: unknown, fieldName: string, maximumLength: number): string {
    if (typeof value !== "string") throw new ValidationError(fieldName + " must be text.");

    const cleanedValue = value.trim();

    if (cleanedValue.length === 0) throw new ValidationError(fieldName + " is required.");
    if (Array.from(cleanedValue).length > maximumLength) throw new ValidationError(fieldName + " must not exceed " + maximumLength + " characters.");

    return cleanedValue;
}

function readOptionalText(value: unknown, fieldName: string, maximumLength: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new ValidationError(fieldName + " must be text.");

    const cleanedValue = value.trim();

    if (cleanedValue.length === 0) return null;
    if (Array.from(cleanedValue).length > maximumLength) throw new ValidationError(fieldName + " must not exceed " + maximumLength + " characters.");

    return cleanedValue;
}

function readPhoneNumber(value: unknown, fieldName: string): string {
    const text = readRequiredText(value, fieldName, 50);

    if (!text.startsWith("+")) throw new ValidationError(fieldName + " must include a country code, such as +91.");

    const parsedNumber = parsePhoneNumberFromString(text, { extract: false });

    if (parsedNumber === undefined || !parsedNumber.isValid()) throw new ValidationError(fieldName + " is not a valid phone number.");
    if (parsedNumber.ext !== undefined) throw new ValidationError(fieldName + " must not include an extension.");

    return parsedNumber.number;
}

interface Env {
    gitanushilanam_db: D1Database;
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "https://gitanushilanam.learngitalivegita.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

function jsonResponse(data: unknown, status = 200): Response {
    return Response.json(data, { status, headers: corsHeaders });
}

const allowedCompetitions = ["bhagavad_gita_quiz", "shloka_recitation", "animated_bg_video", "treasure_hunt"];

const allowedGenders = ["male", "female", "other", "prefer_not_to_say"];

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        if (url.pathname === "/api/test" && request.method === "GET") {
            return jsonResponse({ success: true, message: "Gitanushilanam API is working" });
        }

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

                const name = readRequiredText(data.name, "Name", 100);
                const email = readRequiredText(data.email, "Email", 254).toLowerCase();
                const phone = readPhoneNumber(data.phone, "Phone number");
                const whatsapp = readPhoneNumber(data.whatsapp, "WhatsApp number");

                const gender = readRequiredText(data.gender, "Gender", 30);
                if (!allowedGenders.includes(gender)) throw new ValidationError("Please select a valid gender.");

                const institutionOrganization = readOptionalText(data.institution_organization, "School / Institute / Organization", 200);

                const country = readRequiredText(data.country, "Country", 100);
                const state = readRequiredText(data.state, "State", 100);
                const city = readRequiredText(data.city, "City", 100);
                const heardFrom = readRequiredText(data.heard_from, "How you heard about us", 200);

                if (typeof data.age !== "number") throw new ValidationError("Age must be a number.");

                const age = data.age;

                if (!Number.isInteger(age) || age < 3 || age > 120) {
                    throw new ValidationError("Please enter a valid age.");
                }

                if (!Array.isArray(data.competitions)) {
                    throw new ValidationError("Please select at least one competition.");
                }

                const competitions: string[] = [];

                for (const competition of data.competitions) {
                    if (typeof competition !== "string") throw new ValidationError("Each competition must be text.");
                    competitions.push(competition);
                }

                const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (!emailPattern.test(email)) {
                    return jsonResponse({ success: false, message: "Please enter a valid email address." }, 400);
                }

                if (competitions.length === 0) {
                    return jsonResponse({ success: false, message: "Please select at least one competition." }, 400);
                }

                const invalidCompetition = competitions.some(competition => !allowedCompetitions.includes(competition));

                if (invalidCompetition) {
                    return jsonResponse({ success: false, message: "Invalid competition selected." }, 400);
                }

                const bhagavadGitaQuiz = competitions.includes("bhagavad_gita_quiz") ? 1 : 0;
                const shlokaRecitation = competitions.includes("shloka_recitation") ? 1 : 0;
                const animatedBgVideo = competitions.includes("animated_bg_video") ? 1 : 0;
                const treasureHunt = competitions.includes("treasure_hunt") ? 1 : 0;

                const result = await env.gitanushilanam_db.prepare(`
                    INSERT INTO registrations (
                        name, email, phone, whatsapp, age, gender, institution_organization, country, state, city, heard_from,
                        bhagavad_gita_quiz, shloka_recitation, animated_bg_video, treasure_hunt
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(email, phone) DO NOTHING
                `).bind(
                    name, email, phone, whatsapp, age, gender, institutionOrganization, country, state, city, heardFrom,
                    bhagavadGitaQuiz, shlokaRecitation, animatedBgVideo, treasureHunt
                ).run();

                if (result.meta.changes === 0) {
                    return jsonResponse({ success: false, message: "A registration already exists with this email and phone number." }, 409);
                }

                return jsonResponse({
                    success: true,
                    message: "Registration saved successfully.",
                    id: result.meta.last_row_id
                });

            } catch (error) {
                if (error instanceof ValidationError) {
                    return jsonResponse({ success: false, message: error.message }, 400);
                }

                console.error("Registration error:", error);

                return jsonResponse({ success: false, message: "Unable to process the registration." }, 500);
            }
        }

        return jsonResponse({ success: false, message: "Not Found" }, 404);
    }

} satisfies ExportedHandler<Env>;