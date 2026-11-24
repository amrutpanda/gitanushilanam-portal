import { type Env, ValidationError, isAllowedOrigin, jsonResponse } from "./registration-support";
import { registerMentor } from "./mentor-registration";
import { mentorLogin, mentorSessionResponse, getMentorSession } from "./mentor-auth";
import { findMentor, MENTOR_SELECT, type Mentor, readMentorJson, uuid } from "./mentor-support";
import { sendMentorConfirmation } from "./mentor-email";
import { saveUpload, listUploads, downloadUpload, UploadTooLarge } from "./school-quiz-uploads";

type AdminAuthorizer = (request: Request, env: Env) => Promise<{ admin_id: number; email: string } | Response>;

async function reviewMentors(request: Request, env: Env, url: URL): Promise<Response> {
    const search = (url.searchParams.get("search") || "").trim();
    const pageText = url.searchParams.get("page") || "1";
    if (search.length > 200 || !/^[1-9]\d{0,6}$/u.test(pageText)) throw new ValidationError("Invalid search or page.");
    const page = Number(pageText), size = 25;
    const condition = `(? = '' OR instr(lower(s.name || ' ' || m.name || ' ' || m.email || ' ' || m.phone || ' ' || CAST(s.registration_id AS TEXT)), lower(?)) > 0)`;
    const rows = await env.MENTORS_DB.prepare(`${MENTOR_SELECT} WHERE ${condition} ORDER BY m.created_at DESC, m.id LIMIT ? OFFSET ?`)
        .bind(search, search, size, (page - 1) * size).all<Mentor>();
    const counts = await env.MENTORS_DB.prepare(`SELECT COUNT(*) AS total_mentors, COUNT(DISTINCT m.school_id) AS total_schools,
        COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0) AS matching_mentors
        FROM mentors m JOIN mentor_schools s ON s.registration_id = m.school_id`).bind(search, search)
        .first<{ total_mentors: number; total_schools: number; matching_mentors: number }>();
    return jsonResponse(request, { success: true, mentors: rows.results, ...counts, page,
        total_pages: Math.max(1, Math.ceil((counts?.matching_mentors ?? 0) / size)) });
}
export async function handleMentorRoutes(request: Request, env: Env, authorizeAdmin: AdminAuthorizer): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    try {
        if (request.method !== "GET" && !isAllowedOrigin(request)) return jsonResponse(request, { success: false, message: "Request origin is not allowed." }, 403);
        if (path === "/api/mentors/register" && request.method === "POST") return await registerMentor(request, env);
        if (path === "/api/mentors/login" && request.method === "POST") return await mentorLogin(request, env);
        if (path === "/api/mentors/session" && request.method === "GET") return await mentorSessionResponse(request, env);
        if (path === "/api/mentors/logout" && request.method === "POST") return await mentorSessionResponse(request, env, true);
        const adminRoute = path.startsWith("/api/mentor-admin/");
        const admin = adminRoute ? await authorizeAdmin(request, env) : null;
        if (admin instanceof Response) return admin;
        if (admin && path === "/api/mentor-admin/mentors" && request.method === "GET") return await reviewMentors(request, env, url);
        if (admin && path === "/api/mentor-admin/confirmation" && request.method === "POST") {
            const data = await readMentorJson(request), mentor = await findMentor(env, uuid(data.mentor_id));
            if (!mentor) return jsonResponse(request, { success: false, message: "Mentor not found." }, 404);
            const sent = await sendMentorConfirmation(env, mentor, `mentor-resend-${uuid(data.request_id)}`);
            return jsonResponse(request, { success: sent, message: sent ? "Confirmation email sent." : "Confirmation could not be sent yet. Please retry shortly." }, sent ? 200 : 503);
        }
        const base = adminRoute ? "/api/mentor-admin/uploads" : "/api/mentors/uploads";
        if (path !== base && path !== `${base}/download`) return jsonResponse(request, { success: false, message: "Route not found." }, 404);
        const session = admin ? null : await getMentorSession(request, env);
        if (!admin && !session) return jsonResponse(request, { success: false, message: "Please sign in using Mentor Login." }, 401);
        // A mentor ID is a selector, never a credential. Verify ownership for every operation.
        const id = url.searchParams.get("mentor_id");
        const mentor = id ? await findMentor(env, uuid(id)) : null;
        if ((!admin || request.method === "POST") && (!mentor || (session && (mentor.email !== session.email || mentor.phone !== session.phone)))) {
            return jsonResponse(request, { success: false, message: "Please select a school from your account." }, 403);
        }
        if (request.method === "POST" && path === base && mentor) {
            return await saveUpload(request, env, mentor, admin ? { role: "super_admin", id: String(admin.admin_id) } : { role: "mentor", id: mentor.id });
        }
        if (request.method === "GET") {
            const scope = admin ? null : mentor!.id;
            return path.endsWith("/download") ? await downloadUpload(request, env, url, scope) : await listUploads(request, env, url, scope);
        }
        return jsonResponse(request, { success: false, message: "Method not allowed." }, 405);
    } catch (error) {
        if (error instanceof ValidationError) return jsonResponse(request, { success: false, message: error.message }, 400);
        if (error instanceof UploadTooLarge) return jsonResponse(request, { success: false, message: "Please choose an Excel file no larger than 2 MB (2,000,000 bytes)." }, 413);
        console.error("Mentor service failed:", error instanceof Error ? error.message : "request error");
        return jsonResponse(request, { success: false, message: "Unable to complete this request. Please retry; saved registrations and upload attempts are retained." }, 503);
    }
}
