declare namespace Cloudflare {
    interface Env {
        gitanushilanam_db: D1Database;
        SCHOOL_QUIZ_UPLOADS: D1Database;
        MENTORS_DB: D1Database;
    }
}

declare module "*.sql?raw" {
    const sql: string;
    export default sql;
}
