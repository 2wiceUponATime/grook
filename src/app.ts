import { app, botId } from "./core.js";
import { agent } from "./ai.js";
import { AIMessage, BaseMessage, HumanMessage } from "langchain";

app.use(async function(args) {
    args.logger.debug(args.body);
    return args.next();
})

app.message(async function(data) {
    const message = data.message;
    const client = data.client;
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
    const agentResult = await agent.invoke({ messages }, {
        configurable: {
            channel: message.channel
        }
    });
    const text = agentResult.messages.at(-1)?.content ?? "";
    const newReplies = await getReplies();
    if (!text || newReplies.length > replies.length) {
        console.log("canceled");
    }
    if (typeof text != "string") {
        throw new TypeError(`Expected string, got ${text}`)
    }
    const say = data.say;
    for (const line of text.split("\n")) {
        say({
            channel: message.channel,
            thread_ts: message.ts,
            text: line,
        })
    }
});

await app.start(process.env.PORT ?? 3000);
console.log("Bolt app running");