import { AwsEventV2, AwsResponse } from "@slack/bolt/dist/receivers/AwsLambdaReceiver.js";
import { invoke } from "./ai.js";
import { app, botId, init, receiver } from "./core.js";
import { AIMessage, BaseMessage, HumanMessage } from "langchain";

async function start(env: Record<string, any>) {
    await init(env);

    //console.log("Starting");

    app.use(async function(args) {
        args.logger.debug(args.body);
        return args.next();
    })

    app.message(async function(data) {
        const message = data.message;
        const client = data.client;
        console.log("Responding to message:", message);
        async function getReplies() {
            try {

            let ts = message.ts;
            if ("thread_ts" in message && message.thread_ts) {
                ts = message.thread_ts;
            }
            const repliesData = await client.conversations.replies({
                ts,
                channel: message.channel
            });
            return repliesData.messages ?? [];

            } catch(err) {
                console.log(err);
                throw err;
            }
        }

        const messages: BaseMessage[] = [];
        const replies = await getReplies();
        for (const reply of replies) {
            if (reply.user == botId) {
                messages.push(new AIMessage(reply.text ?? ""));
            } else {
                messages.push(new HumanMessage(
                    `User ID ${reply.user}: ${reply.text}`
                ));
            }
        }
        const agentResult = await invoke(messages, {
            channel: message.channel
        });
        const text = agentResult.content;
        console.log("AI response:", text);
        const newReplies = await getReplies();
        if (!text || newReplies.length > replies.length) {
            console.log("Canceled");
        }
        if (typeof text != "string") {
            throw new TypeError(`Expected string, got ${text}`)
        }
        const thread_ts = message.subtype ? undefined : message.ts
        const say = data.say;
        for (const line of text.split("\n")) {
            if (!line) continue;
            console.log("Sending message:", line);
            await say({
                channel: message.channel,
                thread_ts,
                text: line,
            });
        }
    });
}

async function requestToAws(request: Request): Promise<AwsEventV2> {
    const url = new URL(request.url);
    return {
        version: "2.0",
        routeKey: "$default",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: Object.fromEntries(request.headers.entries()),
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
        await start(env);
        const handler = await receiver.start();
        return awsToResponse(await handler(await requestToAws(request), {}, () => {}));
    }
};