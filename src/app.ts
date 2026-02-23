import type { AwsEventV2, AwsResponse } from "@slack/bolt/dist/receivers/AwsLambdaReceiver.js";
import { invoke } from "./ai.js";
import { app, botId, init, logErrors, receiver } from "./core.js";
import { AIMessage, BaseMessage, ContentBlock, HumanMessage } from "langchain";
import { env } from "cloudflare:workers";
import { client } from "./core.js";
import type { ConversationsRepliesResponse, GenericMessageEvent } from "@slack/web-api";

type Reply = ConversationsRepliesResponse["messages"][number];

async function start() {
    const ALLOWED_CHANNELS = new Set(env.ALLOWED_CHANNELS.split(","))
    await init();

    app.use(async function(args) {
        console.log("Event", args.body);
        return args.next();
    })

    app.message(logErrors(async function(data) {
        const message = data.message;
        const say = data.say;

        // Check if asking about creators first
        const messageText = (message.text ?? "").toLowerCase();
        if (messageText.includes("who made") || messageText.includes("who created") || messageText.includes("your creator") || messageText.includes("made you")) {
            await say({
                text: `Made with 💜 by @2wiceUponATime (https://github.com/2wiceUponATime), Sami Singh (@Sami9889 - https://github.com/Sami9889/), and Gabe Schrock`
            });
            return;
        }

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
            if ("thread_ts" in message && message.thread_ts) {
                ts = message.thread_ts;
            }
            const repliesData = await client.conversations.replies({
                ts,
                channel: message.channel
            });
            return repliesData.messages ?? [];
        }

        let thread_ts: string | undefined = message.ts;
        switch (message.subtype) {
            case "file_share":
            case undefined:
                break;
            case "channel_join":
                thread_ts = undefined;
                break;
            default:
                console.log(`Ignoring ${message.subtype}`);
                return;
        }
        if ("bot_id" in message) {
            console.log("Ignoring bot message");
            return;
        }
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
            // if ("files" in reply && reply.files) {
            //     for (const file of reply.files) {
            //         if (file.mimetype.startsWith("image/")) {
            //             const data = fetch(file.url_private_download, {
            //                 headers: {
            //                     "Authorization": "Bearer " + env.SLACK_BOT_TOKEN,
            //                 }
            //             }).then(async result => {
            //                 if (!result.ok) console.error(result.statusText);
            //                 const buffer = await result.arrayBuffer();
            //                 const base64 = btoa(
            //                     String.fromCharCode(...new Uint8Array(buffer))
            //                 );
            //                 return {
            //                     type: "image_url",
            //                     image_url: {
            //                         url: `data:${file.mimetype};base64,${base64}`,
            //                     }
            //                 }
            //             });
            //             filePromises.push(data);
            //         }
            //     }
            // }
            if (filePromises.length && reply.ts == message.ts) {
                console.log("Got attached images", await Promise.all(filePromises));
            }
            if (reply.user == botId) {
                return new AIMessage(reply.text ?? "");
            }[]
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
        const newReplies = await getReplies();
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
            await say({
                channel: message.channel,
                thread_ts,
                text: line,
            });
        }
    }));
}

async function requestToAws(request: Request): Promise<AwsEventV2> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => headers[k] = v);
    return {
        version: "2.0",
        routeKey: "$default",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers,
        requestContext: { http: { method: request.method, path: url.pathname } },
        body: await request.text() || undefined,
        isBase64Encoded: false,
    };
}

async function awsToResponse(response: AwsResponse): Promise<Response> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers ?? {})) {
        headers.set(key, value.toString());
    }
    return new Response(response.body, {
        headers,
        status: response.statusCode,
    })
}

export default {
    async fetch(request: Request, env: Record<string, any>, _ctx: any) {
        const url = new URL(request.url);
        console.log(request.method, url.pathname);
        await start();
        const handler = await receiver.start();
        return awsToResponse(await handler(await requestToAws(request), {}, () => {}));
    }
};