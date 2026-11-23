declare namespace Cloudflare {
    interface Env {
        gitanushilanam_db: D1Database;
        SCHOOL_QUIZ_UPLOADS: R2Bucket;
    }
}

declare module "*.sql?raw" {
    const sql: string;
    export default sql;
}
