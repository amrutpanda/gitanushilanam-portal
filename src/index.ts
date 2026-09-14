interface Env {
    gitanushilanam_db: D1Database;
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

function jsonResponse(data: unknown, status = 200): Response {
    return Response.json(data, {
        status,
        headers: corsHeaders
    });
}

const allowedCompetitions = [
    "bhagavad_gita_quiz",
    "shloka_recitation",
    "animated_bg_video",
    "treasure_hunt"
];

export default {
    async fetch(request: Request, env: Env): Promise<Response> {

        const url = new URL(request.url);

        /* CORS */

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }


        /* TEST */

        if (url.pathname === "/api/test" && request.method === "GET") {
            return jsonResponse({
                success: true,
                message: "Gitanushilanam API is working"
            });
        }


        /* REGISTER */

        if (url.pathname === "/api/register" && request.method === "POST") {

            try {

                const data = await request.json<{
                    name?: string;
                    email?: string;
                    phone?: string;
                    whatsapp?: string;
                    age?: number;
                    country?: string;
                    state?: string;
                    city?: string;
                    heard_from?: string;
                    competitions?: string[];
                }>();


                /* -----------------------------------------
                   CLEAN DATA
                ----------------------------------------- */

                const name = data.name?.trim() || "";
                const email = data.email?.trim().toLowerCase() || "";
                const phone = data.phone?.trim() || "";
                const whatsapp = data.whatsapp?.trim() || "";
                const country = data.country?.trim() || "";
                const state = data.state?.trim() || "";
                const city = data.city?.trim() || "";
                const heardFrom = data.heard_from?.trim() || "";
                const age = Number(data.age);
                const competitions = Array.isArray(data.competitions) ? data.competitions : [];


                /* -----------------------------------------
                   REQUIRED FIELD VALIDATION
                ----------------------------------------- */

                if (!name || !email || !phone || !whatsapp || !country || !state || !city || !heardFrom) {
                    return jsonResponse({
                        success: false,
                        message: "Please fill in all required fields."
                    }, 400);
                }


                /* -----------------------------------------
                   EMAIL VALIDATION
                ----------------------------------------- */

                const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (!emailPattern.test(email)) {
                    return jsonResponse({
                        success: false,
                        message: "Please enter a valid email address."
                    }, 400);
                }


                /* -----------------------------------------
                   AGE VALIDATION
                ----------------------------------------- */

                if (!Number.isInteger(age) || age < 3 || age > 120) {
                    return jsonResponse({
                        success: false,
                        message: "Please enter a valid age."
                    }, 400);
                }


                /* -----------------------------------------
                   COMPETITION VALIDATION
                ----------------------------------------- */

                if (competitions.length === 0) {
                    return jsonResponse({
                        success: false,
                        message: "Please select at least one competition."
                    }, 400);
                }


                const invalidCompetition = competitions.some(
                    competition => !allowedCompetitions.includes(competition)
                );

                if (invalidCompetition) {
                    return jsonResponse({
                        success: false,
                        message: "Invalid competition selected."
                    }, 400);
                }


                /* -----------------------------------------
                   DUPLICATE CHECK
                ----------------------------------------- */

                const existingRegistration = await env.gitanushilanam_db
                    .prepare(`
                        SELECT id
                        FROM registrations
                        WHERE email = ? AND phone = ?
                        LIMIT 1
                    `)
                    .bind(email, phone)
                    .first();


                if (existingRegistration) {
                    return jsonResponse({
                        success: false,
                        message: "A registration already exists with this email and phone number."
                    }, 409);
                }


                /* -----------------------------------------
                   CONVERT COMPETITIONS TO 1 / 0
                ----------------------------------------- */

                const bhagavadGitaQuiz = competitions.includes("bhagavad_gita_quiz") ? 1 : 0;
                const shlokaRecitation = competitions.includes("shloka_recitation") ? 1 : 0;
                const animatedBgVideo = competitions.includes("animated_bg_video") ? 1 : 0;
                const treasureHunt = competitions.includes("treasure_hunt") ? 1 : 0;


                /* -----------------------------------------
                   INSERT REGISTRATION
                ----------------------------------------- */

                const result = await env.gitanushilanam_db.prepare(`
                    INSERT INTO registrations (
                        name,
                        email,
                        phone,
                        whatsapp,
                        age,
                        country,
                        state,
                        city,
                        heard_from,
                        bhagavad_gita_quiz,
                        shloka_recitation,
                        animated_bg_video,
                        treasure_hunt
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(
                    name,
                    email,
                    phone,
                    whatsapp,
                    age,
                    country,
                    state,
                    city,
                    heardFrom,
                    bhagavadGitaQuiz,
                    shlokaRecitation,
                    animatedBgVideo,
                    treasureHunt
                ).run();


                return jsonResponse({
                    success: true,
                    message: "Registration saved successfully.",
                    id: result.meta.last_row_id
                });

            } catch (error) {

                console.error("Registration error:", error);

                return jsonResponse({
                    success: false,
                    message: "Unable to process the registration."
                }, 500);
            }
        }


        return jsonResponse({
            success: false,
            message: "Not Found"
        }, 404);
    }

} satisfies ExportedHandler<Env>;