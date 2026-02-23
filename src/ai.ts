import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage, createAgent, createMiddleware, tool } from "langchain";
import { Messages } from "@langchain/langgraph";
import { ConversationsInfoResponse, UsersInfoResponse } from "@slack/web-api";
import { env } from "cloudflare:workers"
import { ChatGroq } from "@langchain/groq";
import z from "zod";
import { assertString, botId } from "./core.js";
import basePrompt from "./prompt/prompt.md";
import safeguardPrompt from "./prompt/safeguard.md";
import Exa from "exa-js"
import { client } from "./core.js";

const USER_ID_DESCRIPTION = "The user's member ID, or a comma-separated list of \
them. Example: U12345ABCDE,U67890FGHIJ";
const TEXT_DESCRIPTION = "The message text. To send multiple messages at once, \
place them on separate lines. Example: 'Hello, world!'";
const SKIP_DESCRIPTION = "If true, `skip` will be called after the message is \
sent, ending the agent turn without a response."
const SKIP = z.union([z.boolean(), z.enum(["true", "false"])]).describe(SKIP_DESCRIPTION)

const llm = new ChatGroq({
    model: env.GROQ_MODEL,
    temperature: 0.4,
});

const llmSafeguard = new ChatGroq({
    model: env.GROQ_SAFEGUARD_MODEL,
    temperature: 0,
});

function error(message: string, ...data: unknown[]): string {
    console.log("Tool error:", message, { data });
    return message;
}

function skip(message: string) {
    console.log("Skip", message);
    return "_skip";
}

function handle(err: any) {
    if (err instanceof Error && err.message.includes("API error")) {
        const message = `Slack API error: ${err.message}`;
        console.error(message);
        return message;
    }
    console.error("Other error:", err);
    throw err;
}

function bool(input: z.infer<typeof SKIP>) {
    return input === true || input === "true";
}

const exaClient = new Exa(env.EXASEARCH_API_KEY);

const searchWeb = tool(
    async function(input, config) {
        const channel: string = config.configurable.channel;
        const thread_ts: string = config.configurable.thread_ts;
        const promise = exaClient.search(input.query, {
            numResults: 3,
            contents: {
                highlights: true,
            }
        });
        const message = await client.chat.postMessage({
            channel,
            thread_ts,
            text: `searching the web for "${input.query}"...`
        });
        console.log("Searching web");
        const result = await promise;
        const strings = result.results.map(result =>
            `${result.score ? `Score: ${result.score}\n` : ""}# ${result.title} \
- ${result.url}
${result.highlights.join("\n\n")}`
        );
        console.log("Web search completed", strings);
        await client.chat.delete({
            channel: message.channel,
            ts: message.ts
        });
        return strings;
    },
    {
        name: "search_web",
        description: "Search the web using Exa Search.",
        schema: z.object({
            query: z.string().nonempty()
        })
    }
)

const skipTool = tool(
    function() {
        return skip("skip");
    },
    {
        name: "skip",
        description: "Immediately end the assistant turn without responding \
to the user. Use this when the input message is irrelevant or when you have \
already called send_channel_message and do not want to send another message.",
        schema: z.object({}),
    }
);

const getProfile = tool(
    async function(input) {
        try {
            const result = await client.users.info({ user: input.user_id });
            const profile = result.user?.profile;
            if (!profile) return error("No profile received");
            for (const key in profile) {
                if (key.startsWith("image_")) {
                    delete profile[key as keyof typeof profile];
                }
            }
            return profile;
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "get_profile",
        description: "Get information about a user such as their name.",
        schema: z.object({
            user_id: z.string().describe(USER_ID_DESCRIPTION),
        }),
    }
);

const sendDM = tool(
    async function(input) {
        try {
            if (!input.text.match(/<@u[a-z0-9]{10}>/gi)) {
                return error("Text must mention the person who requested the DM")
            }
            input.text = await safeguard(input.text);
            console.log(`Sending '${input.text}' to ${input.user_id}`)
            const response = await client.conversations.open({
                users: input.user_id
            });
            const channel = response.channel?.id;
            if (!channel) {
                return error("Couldn't open conversation - are you sure that user exists?");
            }
            for (const line of input.text.split("\n")){
                if (!line) continue;
                client.chat.postMessage({
                    channel,
                    text: line,
                })
            }
            if (bool(input.skip_response)) return skip("send_dm");
            return "success";
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "send_direct_message",
        description: "Send a direct message to a user.",
        schema: z.object({
            user_id: z.string().describe(USER_ID_DESCRIPTION),
            text: z.string().describe(TEXT_DESCRIPTION),
            skip_response: SKIP,
        }),
    }
)

const sendChannelMessage = tool(
    async function(input, config) {
        try {
            const channel: string = config.configurable.channel;
            const thread_ts: string = config.configurable.thread_ts;
            input.text = await safeguard(input.text);
            for (const line of input.text.split("\n")) {
                if (!line) continue;
                client.chat.postMessage({
                    channel,
                    thread_ts,
                    reply_broadcast: true,
                    text: line
                });
            }
            if (bool(input.skip_response)) return skip("send_channel_message");
            return "success";
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "send_channel_message",
        description: "Send a top-level message in both the current channel and the current thread.",
        schema: z.object({
            text: z.string().describe(TEXT_DESCRIPTION),
            skip_response: SKIP,
        }),
    }
)

const addReaction = tool(
    async function(input, config) {
        try {
            const channel: string = config.configurable.channel;
            const ts: string = config.configurable.ts;
            // Attempt to read local reaction-tool config to decide save/forward behavior
            let reactionConfig: { force_save?: boolean, slack_forwarding?: boolean, destinations?: Array<{path?:string}> } = {};
            try {
                const fsModule = await import('fs');
                const raw = fsModule.readFileSync('./reaction-tool.yaml', 'utf8');
                const lines = raw.split(/\r?\n/);
                for (const line of lines) {
                    const m = line.match(/^\s*force_save:\s*(.+)$/i);
                    if (m) reactionConfig.force_save = m[1].trim().toLowerCase() === 'true';
                    const m2 = line.match(/^\s*slack_forwarding:\s*(.+)$/i);
                    if (m2) reactionConfig.slack_forwarding = m2[1].trim().toLowerCase() === 'true';
                    const m3 = line.match(/^\s*-\s*type:\s*local_archive$/i);
                    // look for a following `path:` on subsequent lines
                    if (m3) {
                        // noop - type detection only
                    }
                    const m4 = line.match(/^\s*path:\s*(.+)$/i);
                    if (m4) {
                        reactionConfig.destinations = reactionConfig.destinations || [];
                        reactionConfig.destinations.push({ path: m4[1].trim() });
                    }
                }
            } catch (e) {
                // local config not available or not readable; fall back to defaults
            }
            const promises: Promise<unknown>[] = [];
            console.log("react", {
                input,
            });
            // If configured to force-save locally, attempt to persist and skip forwarding
            if (reactionConfig.force_save) {
                try {
                    const fsModule = await import('fs');
                    const pathModule = await import('path');
                    const archivePath = (reactionConfig.destinations && reactionConfig.destinations[0]?.path) || './archives/reactions';
                    fsModule.mkdirSync(archivePath, { recursive: true });
                    const record = {
                        channel,
                        ts,
                        emojis: input.emojis,
                        timestamp: new Date().toISOString(),
                    };
                    const filename = pathModule.join(archivePath, `${Date.now()}.json`);
                    fsModule.writeFileSync(filename, JSON.stringify(record, null, 2), 'utf8');
                    console.log('Saved reaction locally:', filename);
                } catch (e) {
                    console.error('Failed to save reaction locally', e);
                }
                if (reactionConfig.slack_forwarding === false) {
                    if (input.skip_response) return skip("react");
                    return `Saved reaction(s) locally: ${input.emojis.join(", ")}`
                }
            }
            for (let reaction of input.emojis) {
                reaction = reaction.trim();
                if (!reaction) continue;
                promises.push(client.reactions.add({
                    channel,
                    timestamp: ts,
                    name: reaction,
                }));
            }
            await Promise.all(promises);
            if (bool(input.skip_response)) return skip("react");
            return `Reacted with ${input.emojis.join(", ")}`
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "add_reaction",
        description: "Add an emoji reaction to the most recent message.",
        schema: z.object({
            emojis: z.array(z.string().nonempty()).min(1).nonempty().describe(
                'The reaction(s) to add, in separate strings as Slack emoji \
names without surrounding colons (e.g. "grinning" or "keycap_star").'
            ),
            skip_response: SKIP,
        })
    }
)

const getImageDescription = tool(
    async function(input) {
        try {
            if (!env.ANTHROPIC_API_KEY) {
                return error("ANTHROPIC_API_KEY not configured");
            }
            const analysis = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": env.ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 1024,
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image",
                                    source: {
                                        type: "url",
                                        url: input.image_url,
                                    },
                                },
                                {
                                    type: "text",
                                    text: input.question || "Describe this image concisely.",
                                },
                            ],
                        },
                    ],
                }),
            });
            if (!analysis.ok) {
                const errorText = await analysis.text();
                return error(`Vision API error: ${analysis.status} - ${errorText}`);
            }
            const data = await analysis.json() as any;
            const textContent = data.content?.find((b: any) => b.type === "text")?.text;
            return textContent || error("No response from vision API");
        } catch (err) {
            return handle(err);
        }
    },
    {
        name: "analyze_image",
        description: "Analyze an image from a URL using vision. Useful for understanding images shared in messages.",
        schema: z.object({
            image_url: z.string().url().describe("The URL of the image to analyze"),
            question: z.string().optional().describe("Optional specific question about the image. If not provided, a general description will be given."),
        }),
    }
)

const dereferenceArchiveLink = tool(
    async function(input) {
        try {
            if (!input.url.includes("web.archive.org")) {
                return error("URL must be an archive.org link");
            }
            const archiveResponse = await fetch(input.url);
            if (!archiveResponse.ok) {
                return error(`Failed to fetch archive: ${archiveResponse.status}`);
            }
            const html = await archiveResponse.text();
            const textContent = html
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const maxLength = 2000;
            if (textContent.length > maxLength) {
                return textContent.substring(0, maxLength) + "...\n(truncated)";
            }
            return textContent || error("No content found in archive");
        } catch (err) {
            return handle(err);
        }
    },
    {
        name: "dereference_archive_link",
        description: "Fetch and retrieve the content from a web.archive.org link. Useful for accessing historical snapshots of websites.",
        schema: z.object({
            url: z.string().url().describe("The full web.archive.org URL"),
        }),
    }
)

const tools = [
    addReaction,
    searchWeb,
    skipTool,
    getProfile,
    sendDM,
    sendChannelMessage,
    dereferenceArchiveLink,
]

const date = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

console.log("Current date:", date);

const prompt = basePrompt
    .replaceAll("{{BOT_ID}}", botId)
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{CREATOR}}", env.CREATOR_ID
        ? ` You were created by the user with ID ${env.CREATOR_ID}.`
        : ""
    );

const handleSkipMiddleware = createMiddleware({
    name: "HandleSkip",
    beforeModel: {
        canJumpTo: ["end"],
        hook(state) {
            const lastMessage = state.messages.at(-1);
            if (lastMessage instanceof ToolMessage && lastMessage.content == "_skip") {
                return {
                    messages: [new AIMessage("")],
                    jumpTo: "end",
                }
            }
        }
    }
})

const stateSchema = z.object({
    messages: z.any() as z.ZodType<Messages>,
});

const agent = createAgent({
    model: llm,
    middleware: [handleSkipMiddleware],
    tools,
    systemPrompt: prompt,
    stateSchema,
});

const agentSafeguard = createAgent({
    model: llmSafeguard,
    systemPrompt: safeguardPrompt,
    stateSchema,
});

async function safeguard(message: string): Promise<string> {
    const result = await agentSafeguard.invoke({ messages: [new HumanMessage(message)] });
    const lastMessage = result.messages.at(-1);
    if (!(lastMessage instanceof AIMessage)) {
        throw new TypeError(`Expected AIMessage, got ${lastMessage}`);
    }
    const response = lastMessage.content;
    assertString(response);
    if (response.trim().toLowerCase() == "safe") {
        return message
    }
    console.log(`Blocked ${message}: ${response}`)
    return "This message was blocked by the content filter";
}

export async function invoke(
    messages: BaseMessage[],
    configurable: { channel: string, thread_ts: string | undefined, ts: string }
): Promise<string> {
    const channel = configurable.channel.toUpperCase();
    const relevantIDs: Record<string, string> = {};
    for (const message of messages) {
        let content: string[];
        if (typeof message.content == "string") {
            content = [message.content];
        } else {
            content = message.content
                .filter(block => block.type == "text")
                .map(block => (block.text ?? block.content) as string);
        }
        for (const part of content) {
            assertString(part);
            const matches: string[] = part.match(/\b(u|c|d)[a-z0-9]{10}\b/gi) ?? [];
            if (!(channel in relevantIDs)) {
                matches.push(channel);
            }
            for (let match of matches) {
                match = match.toUpperCase();
                if (match in relevantIDs) {
                    continue;
                }
                if (match.startsWith("C") || match.startsWith("D")) {
                    let result: ConversationsInfoResponse;
                    try {
                        result = await client.conversations.info({ channel: match });
                    } catch (err) {
                        console.error(err);
                        relevantIDs[match] = "unknown/nonexistent/private";
                        continue;
                    }
                    if (match == channel) {
                        match += " (current channel)";
                    }
                    relevantIDs[match] = result.channel.name ?? "direct message";
                    continue;
                }
                let result: UsersInfoResponse;
                try {
                    result = await client.users.info({ user: match });
                } catch (err) {
                    console.error(err);
                    relevantIDs[match] = "unknown/nonexistent";
                    continue;
                };
                const profile = result.user.profile;
                relevantIDs[match] = profile.display_name || profile.real_name;
            }
        }
    }
    console.log("Relevant IDs:", relevantIDs)
    let prompt = "Relevant IDs (U = User, C/D = Channel):\n";
    for (const [key, value] of Object.entries(relevantIDs)) {
        prompt += `${key}: ${value}\n`
    }
    const addedMessage = new SystemMessage(prompt);
    const result = await agent.invoke({
        messages: messages.concat([addedMessage]),
    }, { configurable });
    const lastMessage = result.messages.at(-1);
    if (lastMessage instanceof AIMessage) {
        assertString(lastMessage.content);
        return await safeguard(lastMessage.content);
    }
    throw new TypeError(`Expected AIMessage, got ${lastMessage}`);
}