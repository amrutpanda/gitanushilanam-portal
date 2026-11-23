import {
    type Env, ValidationError, getCorsHeaders, isAllowedOrigin,
    jsonResponse, readRequiredText, verifyTurnstile
} from "./registration-support";

const UPLOAD_PATH = "/api/school-quiz/uploads";
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 100_000_000;
const CHUNK_BYTES = 500_000;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
const PAGE_SIZE = 25;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_PATTERN = /^school-quiz\/[0-9a-f-]{36}\/[0-9a-f]{64}\.xlsx$/u;

type AuthorizeReview = (request: Request, env: Env) => Promise<unknown | Response>;

interface UploadRecord {
    school_name: string;
    state: string | null;
    city: string | null;
    original_filename: string;
    file_key: string;
    file_size: number;
    uploaded_at: string;
}

class UploadTooLarge extends Error {}

// Native base64 conversion avoids D1's large byte-array JSON serialization.
// Base64 is only a lossless storage encoding; no Excel content is parsed.
function encodeBytes(bytes: Uint8Array): string {
    return (bytes as Uint8Array & { toBase64(): string }).toBase64();
}

function decodeBytes(value: string): Uint8Array {
    return (Uint8Array as typeof Uint8Array & { fromBase64(value: string): Uint8Array }).fromBase64(value);
}

// Bound the actual body, even when Content-Length is absent. No workbook parsing.
async function readUploadForm(request: Request): Promise<FormData> {
    const contentType = request.headers.get("Content-Type") || "";
    if (!/^multipart\/form-data\s*;/iu.test(contentType)) {
        throw new ValidationError("Please upload the Excel file using the upload form.");
    }
    if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) throw new UploadTooLarge();
    if (!request.body) throw new ValidationError("Please choose an Excel file.");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_REQUEST_BYTES) {
                await reader.cancel();
                throw new UploadTooLarge();
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    } catch {
        throw new ValidationError("The upload could not be read. Please choose the file again.");
    }
}

async function saveUpload(request: Request, env: Env): Promise<Response> {
    if (!isAllowedOrigin(request)) {
        return jsonResponse(request, { success: false, message: "Request origin is not allowed." }, 403);
    }
    const form = await readUploadForm(request);
    const school = readRequiredText(form.get("school_name"), "School name", 200);
    const requestKey = readRequiredText(form.get("request_id"), "Upload retry key", 36).toLowerCase();
    if (!UUID_PATTERN.test(requestKey)) throw new ValidationError("Please refresh the upload page and try again.");
    const token = readRequiredText(form.get("turnstile_token"), "Security verification", 2048);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Please choose a non-empty Excel (.xlsx) file.");
    if (file.size > MAX_FILE_BYTES) throw new UploadTooLarge();
    const filename = readRequiredText(file.name, "Filename", 180);
    if (!/\.xlsx$/iu.test(filename) || /[\/\\\u0000-\u001f\u007f]/u.test(filename)) {
        throw new ValidationError("Please upload an Excel .xlsx file with a valid filename.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // XLSX is a ZIP container. This is a signature check, not cell/row validation.
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
        throw new ValidationError("This file is not an Excel .xlsx container. Please use the downloaded template.");
    }
    if (!await verifyTurnstile(token, request, env.TURNSTILE_SECRET_KEY, "school_quiz_upload")) {
        return jsonResponse(request, { success: false, message: "Security verification failed. Please complete it again and retry." }, 403);
    }

    // The browser retains an opaque attempt key. Include the bytes and metadata in
    // the file key so neither a key collision nor a changed file can overwrite data.
    const metadata = new TextEncoder().encode(JSON.stringify([school, filename]) + "\n");
    const fingerprintInput = new Uint8Array(metadata.length + bytes.length);
    fingerprintInput.set(metadata);
    fingerprintInput.set(bytes, metadata.length);
    const digest = await crypto.subtle.digest("SHA-256", fingerprintInput);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = `school-quiz/${requestKey}/${hash}.xlsx`;

    const db = env.SCHOOL_QUIZ_UPLOADS;
    // Capacity enforcement runs inside this INSERT transaction. Concurrent uploads
    // cannot both claim the same remaining space; existing retries cost no space.
    const statements = [db.prepare(`
        INSERT INTO school_quiz_uploads (school_name, original_filename, file_key, file_size, uploaded_at)
        SELECT ?, ?, ?, ?, ? WHERE
            EXISTS (SELECT 1 FROM school_quiz_uploads WHERE file_key = ?)
            OR (SELECT COALESCE(SUM(file_size), 0) FROM school_quiz_uploads) + ? <= ?
        ON CONFLICT(file_key) DO NOTHING
    `).bind(school, filename, key, file.size, new Date().toISOString(), key, file.size, MAX_TOTAL_BYTES)];
    for (let start = 0, part = 0; start < bytes.length; start += CHUNK_BYTES, part++) {
        statements.push(db.prepare(`
            INSERT INTO school_quiz_upload_chunks (file_key, part, content)
            SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM school_quiz_uploads WHERE file_key = ?)
            ON CONFLICT(file_key, part) DO NOTHING
        `).bind(key, part, encodeBytes(bytes.subarray(start, start + CHUNK_BYTES)), key));
    }
    statements.push(db.prepare("SELECT uploaded_at FROM school_quiz_uploads WHERE file_key = ?").bind(key));
    // D1 batch is atomic: failed writes leave neither a partial file nor a reservation.
    const results = await db.batch<{ uploaded_at: string }>(statements);
    const timestamp = results.at(-1)?.results[0]?.uploaded_at;
    if (!timestamp) return jsonResponse(request, {
        success: false, message: "The upload collection has reached its 100 MB capacity. Please contact the organizers."
    }, 507);

    return jsonResponse(request, {
        success: true,
        message: "File received. Student registrations will be processed later.",
        school_name: school,
        original_filename: filename,
        uploaded_at: timestamp
    });
}

async function listUploads(request: Request, env: Env, url: URL): Promise<Response> {
    const search = (url.searchParams.get("school") || "").trim();
    if (Array.from(search).length > 200) throw new ValidationError("School search must not exceed 200 characters.");
    const pageValue = url.searchParams.get("page") || "1";
    if (!/^[1-9]\d{0,6}$/u.test(pageValue)) throw new ValidationError("Invalid page number.");
    const page = Number(pageValue);
    // instr treats wildcard characters literally, unlike a user-provided LIKE pattern.
    const filter = "(? = '' OR instr(lower(school_name), lower(?)) > 0)";
    const counts = await env.SCHOOL_QUIZ_UPLOADS.prepare(`
        SELECT COUNT(*) AS total_uploads, COALESCE(SUM(file_size), 0) AS storage_used_bytes,
            COALESCE(SUM(CASE WHEN ${filter} THEN 1 ELSE 0 END), 0) AS matching_uploads
        FROM school_quiz_uploads
    `).bind(search, search).first<{ total_uploads: number; matching_uploads: number; storage_used_bytes: number }>();
    const result = await env.SCHOOL_QUIZ_UPLOADS.prepare(`
        SELECT school_name, state, city, original_filename, file_key, file_size, uploaded_at
        FROM school_quiz_uploads WHERE ${filter}
        ORDER BY uploaded_at DESC, file_key DESC LIMIT ? OFFSET ?
    `).bind(search, search, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<UploadRecord>();
    return jsonResponse(request, {
        success: true, uploads: result.results,
        total_uploads: counts?.total_uploads ?? 0,
        matching_uploads: counts?.matching_uploads ?? 0,
        storage_used_bytes: counts?.storage_used_bytes ?? 0, storage_limit_bytes: MAX_TOTAL_BYTES,
        page, page_size: PAGE_SIZE,
        total_pages: Math.max(1, Math.ceil((counts?.matching_uploads ?? 0) / PAGE_SIZE))
    });
}

async function downloadUpload(request: Request, env: Env, url: URL): Promise<Response> {
    const key = url.searchParams.get("key") || "";
    if (!KEY_PATTERN.test(key)) throw new ValidationError("Invalid file selection.");
    const row = await env.SCHOOL_QUIZ_UPLOADS.prepare(
        "SELECT original_filename, file_size FROM school_quiz_uploads WHERE file_key = ?"
    ).bind(key).first<{ original_filename: string; file_size: number }>();
    if (!row) return jsonResponse(request, { success: false, message: "Upload not found." }, 404);
    const chunks = await env.SCHOOL_QUIZ_UPLOADS.prepare(
        "SELECT part, content FROM school_quiz_upload_chunks WHERE file_key = ? ORDER BY part"
    ).bind(key).all<{ part: number; content: string }>();
    if (row.file_size < 1 || row.file_size > MAX_FILE_BYTES) throw new Error("Invalid stored file size.");
    const bytes = new Uint8Array(row.file_size);
    let offset = 0;
    for (const [part, chunk] of chunks.results.entries()) {
        const data = decodeBytes(chunk.content);
        if (chunk.part !== part || data.length !== Math.min(CHUNK_BYTES, row.file_size - offset)) {
            throw new Error("Stored file is incomplete.");
        }
        bytes.set(data, offset);
        offset += data.length;
    }
    if (offset !== row.file_size) throw new Error("Stored file is incomplete.");
    const encodedFilename = encodeURIComponent(row.original_filename).replace(/[!'()*]/gu,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(bytes, {
        headers: {
            ...getCorsHeaders(request),
            "Content-Type": XLSX_TYPE,
            "Content-Length": String(row.file_size),
            "Content-Disposition": `attachment; filename="school-quiz.xlsx"; filename*=UTF-8''${encodedFilename}`,
            "Cache-Control": "private, no-store"
        }
    });
}

export async function handleSchoolQuizUploads(
    request: Request, env: Env, authorizeReview: AuthorizeReview
): Promise<Response> {
    const url = new URL(request.url);
    try {
        if (url.pathname === UPLOAD_PATH && request.method === "POST") return await saveUpload(request, env);
        if ((url.pathname === UPLOAD_PATH || url.pathname === `${UPLOAD_PATH}/download`) && request.method === "GET") {
            const session = await authorizeReview(request, env);
            if (session instanceof Response) return session;
            return url.pathname === UPLOAD_PATH
                ? await listUploads(request, env, url)
                : await downloadUpload(request, env, url);
        }
        return jsonResponse(request, { success: false, message: "Upload route or method not found." }, 404);
    } catch (error) {
        if (error instanceof UploadTooLarge) {
            return jsonResponse(request, { success: false, message: "Please choose an Excel file no larger than 2 MB (2,000,000 bytes)." }, 413);
        }
        if (error instanceof ValidationError) return jsonResponse(request, { success: false, message: error.message }, 400);
        console.error("School quiz upload service failed:", error);
        return jsonResponse(request, { success: false, message: "Unable to complete this request. Please retry; a saved upload will not be duplicated." }, 503);
    }
}
