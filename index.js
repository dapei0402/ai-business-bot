const TELEGRAM_BOT_TOKEN = "Enter your Bot Token";
const MY_TELEGRAM_ID = 123456789; // 你自己的 Telegram 数字 ID
const OFFLINE_TIMEOUT_MINUTES = 1; // 你离线后多久机器人才开始代你回复（单位：分钟）
const MISTRAL_API_KEY = "Enter your AI token";
const MISTRAL_BASE_URL = "https://Base url/v1/chat/completions";
const MISTRAL_MODEL = "Model";


export default {
    async fetch(request, env, ctx) {
        if (request.method !== "POST") return new Response("OK", { status: 200 });

        try {
            const update = await request.json();

            if (update.business_message) {
                const msg = update.business_message;
                const chatId = msg.chat.id.toString();
                const fromId = msg.from.id;
                const text = msg.text || "";
                const businessConnectionId = msg.business_connection_id;

                const firstName = msg.from.first_name || "";
                const lastName = msg.from.last_name || "";
                const userName = `${firstName} ${lastName}`.trim() || "用户";

                if (!text) return new Response("OK", { status: 200 });


                if (fromId === MY_TELEGRAM_ID) {
                    if (text.includes("机器人")) {
                        await sendTelegramMessage(chatId, "在的，我的主人", businessConnectionId);
                        return new Response("OK", { status: 200 });
                    }


                    if (env.BOT_KV) {
                        await env.BOT_KV.put(`pause_${chatId}`, Date.now().toString());
                        await updateHistory(env.BOT_KV, chatId, { role: "assistant", content: text });

                        await sendDebugLog(`ℹ️ 日志：你在聊天 ${chatId} 中发了消息。机器人在该聊天中静默 1 分钟，以免打扰你的对话。`);
                    } else {
                        await sendDebugLog("⚠️ 错误：Cloudflare 的 KV 数据库未连接！机器人的记忆功能无法工作。");
                    }
                    return new Response("OK", { status: 200 });
                }

                let chatHistory = [];
                if (env.BOT_KV) {
                    chatHistory = await updateHistory(env.BOT_KV, chatId, { role: "user", content: text });

                    const lastActiveStr = await env.BOT_KV.get(`pause_${chatId}`);
                    if (lastActiveStr) {
                        const lastActive = parseInt(lastActiveStr);
                        const minutesPassed = (Date.now() - lastActive) / (1000 * 60);

                        if (minutesPassed < OFFLINE_TIMEOUT_MINUTES) {
                            await sendDebugLog(`ℹ️ 日志：用户发来消息，但因为你刚刚发过消息（静默状态），机器人没有代你回复他。`);
                            return new Response("OK", { status: 200 });
                        } else {
                            await env.BOT_KV.delete(`pause_${chatId}`);
                        }
                    }
                } else {
                    chatHistory = [{ role: "user", content: text }];
                }

                await sendChatAction(chatId, businessConnectionId);

                const aiReply = await askMistral(chatHistory, userName);

                if (aiReply) {
                    await sendTelegramMessage(chatId, aiReply, businessConnectionId);
                    if (env.BOT_KV) {
                        await updateHistory(env.BOT_KV, chatId, { role: "assistant", content: aiReply });
                    }
                }
            }
        } catch (err) {
            await sendDebugLog(`❌ 代码中发生未预期的错误：\n${err.message}`);
        }

        return new Response("OK", { status: 200 });
    }
};


async function sendChatAction(chatId, businessConnectionId) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            action: "typing", // 告诉 Telegram 把状态设为“正在输入”
            business_connection_id: businessConnectionId // 商务聊天必须传此字段
        })
    });
}

// 这部分会把所有日志发送到你自己的机器人私聊里，如果你不想要可以关掉它
async function sendDebugLog(text) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: MY_TELEGRAM_ID,
            text: text
        })
    });
}


async function updateHistory(kv, chatId, newMessage) {
    const historyKey = `history_${chatId}`;
    let history = [];

    const existingHistory = await kv.get(historyKey);
    if (existingHistory) {
        try { history = JSON.parse(existingHistory); } catch (e) {}
    }

    history.push(newMessage);
    if (history.length > 6) history = history.slice(history.length - 6); // 在这里可以设置作为历史记录、发送给模型的最近几条消息数量

    await kv.put(historyKey, JSON.stringify(history));
    return history;
}


async function sendTelegramMessage(chatId, text, businessConnectionId) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            business_connection_id: businessConnectionId
        })
    });
}


async function askMistral(chatHistory, userName) {
    const systemPrompt = `你是一个正在用自己的私人 Telegram 聊天的真实人类。
你的任务：
1. 理解用户的消息，并完全按照他的语气来回复。
2. 回复长度要适中、自然。
3. 正在和你聊天的用户名字是“${userName}”。请在对话中自然、友好地穿插使用他的名字（但不要用得太频繁）。
4. 如果用户问是谁创造了你，你知道自己是由培哥创造的。一定要说是培哥。
5. 你和用户之间最近 6 条消息的历史记录已提供给你，方便你理解对话的来龙去脉。`;

    const messages = [{ role: "system", content: systemPrompt }, ...chatHistory];

    try {
        const response = await fetch(MISTRAL_BASE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${MISTRAL_API_KEY}`
            },
            body: JSON.stringify({
                model: MISTRAL_MODEL,
                messages: messages
            })
        });

        if (response.ok) {
            const data = await response.json();
            return data.choices[0].message.content;
        } else {
            const errorText = await response.text();
            await sendDebugLog(`❌ Mistral API 错误：\n状态码: ${response.status}\n详情: ${errorText}`);
            return null;
        }
    } catch (error) {
        await sendDebugLog(`❌ 连接 Mistral 服务器出错：\n${error.message}`);
    }

    return null;
}
