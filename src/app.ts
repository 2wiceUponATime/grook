import { MessageEventRequest, SlackApp } from "slack-cloudflare-workers";
import { invoke } from "./ai.js";
import { botId, client, images, init, logErrors } from "./core.js";
import { AIMessage, BaseMessage, ContentBlock, HumanMessage } from "langchain";
import { env } from "cloudflare:workers";
import type { ConversationsRepliesResponse, GenericMessageEvent } from "@slack/web-api";
import { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse.js";

type Reply = ConversationsRepliesResponse["messages"][number];
type Args<F> = F extends (...args: infer T) => any ? T : never;
type AppArgs<K extends keyof SlackApp<any>> = Args<SlackApp<any>[K]>
type MessageData = Args<AppArgs<"anyMessage">[0]>[0]

const ALLOWED_CHANNELS = new Set(env.ALLOWED_CHANNELS.split(","));

function isIgnored(message: MessageData["payload"] | MessageElement) {
    if (message.subtype && message.subtype !== "file_share") return true;
    if ("bot_id" in message) return true;
    return false;
}

async function start(app: SlackApp<any>) {
    await init();

    app.anyMessage(logErrors(async function(req) {
        const message = req.payload;
        console.log("Event", message);
        if (!(message.channel.startsWith("D") || ALLOWED_CHANNELS.has(message.channel))) {
            console.log("Bad channel:", message.channel);
            if (message.subtype) return;
            await client.chat.postEphemeral({
                channel: message.channel,
                user: (message as GenericMessageEvent).user,
                text: `Ask <@${env.CREATOR_ID}> if you want Grook in this channel.`,
            });
            await client.conversations.leave({
                channel: message.channel
            });
            return;
        }
        async function getReplies() {
            let ts = message.ts;
            if (message.thread_ts) {
                ts = message.thread_ts;
            }
            const repliesData = await client.conversations.replies({
                ts,
                channel: message.channel
            });
            return repliesData.messages ?? [];
        }

        let thread_ts: string | undefined = message.ts;
        if (isIgnored(message)) return;
        const replies = await getReplies();
        if (replies.at(-1).user == botId) {
            console.log("Canceled - last message from bot");
            return;
        }
        const reactions = await client.reactions.get({
            channel: message.channel,
            timestamp: message.ts,
            full: true,
        });
        for (const reaction of reactions.message?.reactions ?? []) {
            if (reaction.users && reaction.users.includes(botId)) {
                console.log("Canceled - reaction from bot");
            }
        }
        async function convertReply(reply: Reply): Promise<BaseMessage> {
            const filePromises: Promise<ContentBlock>[] = [];
            if ("files" in reply && reply.files) {
                for (const file of reply.files) {
                    if (file.mimetype.startsWith("image/")) {
                        const data = fetch(file.url_private_download, {
                            headers: {
                                "Authorization": "Bearer " + env.SLACK_BOT_TOKEN,
                            }
                        }).then(async result => {
                            if (!result.ok) console.error(result.statusText);
                            const buffer = await result.arrayBuffer();
                            const base64 = Buffer.from(buffer).toString("base64");
                            const id = crypto.randomUUID();
                            images[id] = `data:${file.mimetype};base64,${base64}`
                            return {
                                type: "text",
                                text: `Attached image: ID ${id}`
                            }
                        });
                        filePromises.push(data);
                    }
                }
            }
            if (filePromises.length && reply.ts == message.ts) {
                console.log("Got attached images", await Promise.all(filePromises));
            }
            if (reply.user == botId) {
                return new AIMessage(reply.text ?? "");
            }
            const files = filePromises.length ? await Promise.all(filePromises) : [];
            return new HumanMessage({
                content: [{
                    type: "text",
                    text: `User ID ${reply.user}: ${reply.text}`
                }, ...files]
            });
        }
        const messages: BaseMessage[] = Array(replies.length);
        const promises: Promise<unknown>[] = Array(replies.length);
        for (const [idx, reply] of replies.entries()) {
            promises[idx] = convertReply(reply).then(result => {
                messages[idx] = result
            });
        }
        await Promise.all(promises);
        if (message.subtype) {
            console.log(`Responding to ${message.subtype}`);
        }
        const text = await invoke(messages, {
            channel: message.channel,
            thread_ts,
            ts: message.ts,
        });
        console.log("AI response:", text);
        const newReplies = (await getReplies()).filter(msg => !isIgnored(msg));
        if (!text.trim()) {
            console.log("Canceled - empty message");
        }
        if (message.ts != newReplies.at(-1).ts) {
            console.log("Canceled - history updated");
            return;
        }
        for (const line of text.split("\n")) {
            if (!line) continue;
            console.log("Sending message:", line);
            await client.chat.postMessage({
                channel: message.channel,
                thread_ts,
                text: line,
            });
        }
    }));
}

export default {
    async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
        const url = new URL(request.url);
        console.log(request.method, url.pathname);
        const app = new SlackApp({
            env: {
                SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN as string,
                SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET as string,
            },
        });
        await start(app);
        return await app.run(request, ctx);
    }
};