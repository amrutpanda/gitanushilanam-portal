import { type Env, ValidationError, readRequiredText, readPhoneNumber } from "./registration-support";

export const MENTOR_SELECT = `SELECT m.id, m.school_id, m.name, m.email, m.phone, m.designation,
    m.total_strength, m.willing_count, m.created_at, m.email_sent_at,
    s.name AS school_name, s.state, s.district, s.place
    FROM mentors m JOIN mentor_schools s ON s.registration_id = m.school_id`;
export interface Mentor {
    id: string; school_id: number; name: string; email: string; phone: string; designation: string;
    total_strength: number; willing_count: number; created_at: string; email_sent_at: string | null;
    school_name: string; state: string; district: string; place: string;
}
export const INDIAN_STATES = [
    "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
    "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
    "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
    "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
    "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"
];
export function mentorEmail(value: unknown): string {
    const email = readRequiredText(value, "School email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ValidationError("Enter a valid school email address.");
    return email;
}
export function mentorPhone(value: unknown): string {
    const text = readRequiredText(value, "Mentor phone", 50).replace(/[\s()-]/gu, "");
    const phone = readPhoneNumber(/^\d{10}$/u.test(text) ? `+91${text}` : text, "Mentor phone");
    if (!/^\+91\d{10}$/u.test(phone)) throw new ValidationError("Enter a valid 10-digit Indian phone number.");
    return phone;
}
export function uuid(value: unknown): string {
    const key = readRequiredText(value, "Request identifier", 36).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(key)) {
        throw new ValidationError("Please refresh the page and try again.");
    }
    return key;
}
export async function sha256(value: string): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function mentorGroup(env: Env): string {
    const link = env.MENTOR_WHATSAPP_GROUP;
    if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/u.test(link || "")) throw new Error("Mentor WhatsApp group is not configured.");
    return link;
}
export async function readMentorJson(request: Request): Promise<Record<string, unknown>> {
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        throw new ValidationError("Please submit the form as JSON.");
    }
    if (!request.body) throw new ValidationError("Please complete the form.");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16384) { await reader.cancel(); throw new ValidationError("The form is too large."); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ValidationError("Please submit a valid form."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ValidationError("Please complete the form.");
    return data as Record<string, unknown>;
}
export function findMentor(env: Env, id: string): Promise<Mentor | null> {
    return env.MENTORS_DB.prepare(`${MENTOR_SELECT} WHERE m.id = ?`).bind(id).first<Mentor>();
}
