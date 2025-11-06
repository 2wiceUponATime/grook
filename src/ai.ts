import { AIMessage, BaseMessage, createAgent, tool } from "langchain";
import { ChatGroq } from "@langchain/groq";
import z from "zod";
import { app, botId } from "./core.js";
import { readFile } from "fs/promises";

class Skip extends Error {}

const USER_ID_DESCRIPTION = "The user's member ID. Example: U12345ABCDE";
const TEXT_DESCRIPTION = "The message text. To send multiple messages at once, \
place them on separate lines. Example: 'Hello, world!'";
const DONE_DESCRIPTION = "If true, `skip` will be called after the message is \
sent."

const llm = new ChatGroq({
    model: "openai/gpt-oss-120b",
    temperature: 0.4,
});

const skip = tool(
    function(_input) {
        throw new Skip();
    },
    {
        name: "skip",
        description: "Immediately end the assistant turn without responding \
to the user.",
        schema: z.object({}),
    }
);

const getProfile = tool(
    async function(input) {
        try {
            const result = await app.client.users.info({ user: input.user_id });
            const profile = result.user?.profile;
            if (!profile) return "No profile recieved";
            for (const key in profile) {
                if (key.startsWith("image_")) {
                    delete profile[key as keyof typeof profile];
                }
            }
            return profile;
        } catch(err) {
            throw err;
        }
    },
    {
        name: "get_profile",
        description: "Get information about a user such as their name.",
        schema: z.object({
            user_id: z.string().describe(USER_ID_DESCRIPTION),
        })
    }
);

const sendDM = tool(
    async function(input) {
        const response = await app.client.conversations.open({
            users: input.user_id
        });
        const channel = response.channel?.id;
        if (!channel) {
            return "Couldn't open conversation";
        }
        for (const line of input.text.split("\n")){
            app.client.chat.postMessage({
                channel,
                text: line,
            })
        }
        if (input.done) throw new Skip();
    },
    {
        name: "send_direct_message",
        description: "Send a direct message to a user.",
        schema: z.object({
            user_id: z.string().describe(USER_ID_DESCRIPTION),
            text: z.string().describe(TEXT_DESCRIPTION),
            done: z.boolean().default(false).describe(DONE_DESCRIPTION),
        })
    }
)

const sendChannelMessage = tool(
    async function(input, config) {
        const channel: string = config.configurable.channel;
        for (const line of input.text.split("\n")) {
            app.client.chat.postMessage({
                channel,
                text: line
            })
        }
        if (input.done) throw new Skip();
    },
    {
        name: "send_channel_message",
        description: "Send a top-level message in the current channel.",
        schema: z.object({
            text: z.string().describe(TEXT_DESCRIPTION),
            done: z.boolean().default(false).describe(DONE_DESCRIPTION),
        })
    }
)

const tools = [
    skip,
    getProfile,
    sendDM,
    sendChannelMessage,
]

const prompt = (await readFile("prompt.md", "utf8"))
    .replaceAll("{BOT_ID}", botId)
    .replaceAll("{CREATOR}", process.env.CREATOR_ID
        ? ` You were created by the user with ID ${process.env.CREATOR_ID}.`
        : ""
    );

export const agent = createAgent({
    model: llm,
    tools,
    systemPrompt: prompt,
});

export async function invoke(
    messages: BaseMessage[],
    configurable: Record<string, any> = {}
): Promise<AIMessage> {
    try {
        const result = await agent.invoke({ messages }, { configurable });
        const lastMessage = result.messages.at(-1);
        if (lastMessage instanceof AIMessage) {
            return lastMessage
        }
        throw new TypeError(`Expected AIMessage, got ${lastMessage}`);
    } catch(err) {
        if (err instanceof Skip) {
            return new AIMessage("");
        }
        throw err;
    } 
}