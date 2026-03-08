import { env } from "cloudflare:workers";
import { WebClient } from "@slack/web-api";

export let botId: string;
export const client = new WebClient(env.SLACK_BOT_TOKEN);
export let images: Record<string, string> = {};

export async function init() {
    const authResponse = await client.auth.test();
    botId = authResponse.user_id ?? "unknown";
}

export function assertString(data: unknown): asserts data is string {
    if (typeof data != "string") {
        throw new TypeError(`Expected string, got ${typeof data}`)
    }
}

export function logErrors<T extends (...args: any[]) => any>(inner: T) {
    return (async (...args: any[]) => {
        try {
            return await inner(...args);
        } catch(err) {
            console.error(err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            throw err;
        }
    }) as T;
}