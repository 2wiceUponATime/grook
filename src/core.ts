import { App } from "@slack/bolt";

export const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const authResponse = await app.client.auth.test();
export const botId = authResponse.user_id;