declare namespace Cloudflare {
    interface Env {
        gitanushilanam_db: D1Database;
    }
}

declare module "*.sql?raw" {
    const sql: string;
    export default sql;
}
