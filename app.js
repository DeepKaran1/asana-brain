require("dotenv").config();

const { App } = require("@slack/bolt");
const { getCacheForProject }                         = require("./cache");
const { askBrain }                                   = require("./brain");
const { getChannelMapping, getChannelProject,
        getChannelFormat, setChannelProject,
        setChannelFormat, clearChannelProject }      = require("./channelStore");

const app = new App({
  token:      process.env.SLACK_BOT_TOKEN,
  appToken:   process.env.SLACK_APP_TOKEN,
  socketMode: true
});

/**
 * Channels waiting for an Asana project name.
 * Structure: { [channel_id]: thread_ts }
 */
const pendingChannels = {};

/**
 * Channels waiting for a GID after a name lookup failure.
 * Structure: { [channel_id]: thread_ts }
 */
const pendingGidChannels = {};

// ─────────────────────────────────────────────
// Helper: post a message into a thread (or channel if no thread_ts)
// ─────────────────────────────────────────────
async function reply(channel, thread_ts, text) {
  const payload = { channel, text };
  if (thread_ts) payload.thread_ts = thread_ts;
  await app.client.chat.postMessage(payload);
}

// ─────────────────────────────────────────────
// Helper: post settings buttons into the thread
// ─────────────────────────────────────────────
async function postSettingsButtons(channel, thread_ts) {
  const current = getChannelFormat(channel);

  await app.client.chat.postMessage({
    channel,
    thread_ts,
    text: "Asana Brain — Response Format Settings",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Response Format Settings*\n\nCurrent: *${current === "bullets" ? "Bullet Points ✅" : "Paragraphs ✅"}*\n\nChoose how answers should be formatted in this channel:`
        }
      },
      {
        type: "actions",
        block_id: "format_settings",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔘 Bullet Points" },
            value: channel,
            action_id: "set_format_bullets",
            style: current === "bullets" ? "primary" : undefined
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📝 Paragraphs" },
            value: channel,
            action_id: "set_format_paragraphs",
            style: current === "paragraphs" ? "primary" : undefined
          }
        ]
      }
    ]
  });
}

// ─────────────────────────────────────────────
// 1. @mention handler
// ─────────────────────────────────────────────
app.event("app_mention", async ({ event }) => {
  const channel   = event.channel;
  const text      = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const thread_ts = event.thread_ts || event.ts;

  console.log(`[App] Mention | channel: ${channel} | thread: ${thread_ts} | text: "${text}"`);

  try {
    const mapped = getChannelProject(channel);

    // ── CASE 1: Not connected yet ──────────────────────────────────────────
    if (!mapped) {
      if (!text) {
        pendingChannels[channel] = thread_ts;
        await reply(channel, thread_ts,
          "👋 Hi! I'm Asana Brain.\n\nWhich Asana project should I connect this channel to?\n_Just reply with the project name — no need to mention me again._"
        );
        return;
      }
      await connectChannel(channel, thread_ts, text);
      return;
    }

    // ── CASE 2: Connected — special commands ──────────────────────────────
    const lower = text.toLowerCase();

    if (lower === "switch project") {
      clearChannelProject(channel);
      pendingChannels[channel] = thread_ts;
      await reply(channel, thread_ts,
        `🔄 Disconnected from *${mapped}*.\n\nReply with the new Asana project name to reconnect.`
      );
      return;
    }

    if (lower === "status") {
      const mapping = getChannelMapping(channel);
      await reply(channel, thread_ts,
        `📌 Connected to *${mapping.projectName}*\n` +
        `Format: *${mapping.format === "bullets" ? "Bullet Points" : "Paragraphs"}*\n\n` +
        `Type \`@Asana Brain settings\` to change format.\n` +
        `Type \`@Asana Brain switch project\` to change project.`
      );
      return;
    }

    if (lower === "settings") {
      await postSettingsButtons(channel, thread_ts);
      return;
    }

    if (!text) {
      await reply(channel, thread_ts,
        `📌 Connected to *${mapped}*. Ask me anything!\n_Type \`@Asana Brain switch project\` to change projects._`
      );
      return;
    }

    // ── CASE 3: Answer the question ────────────────────────────────────────
    await answerQuestion(text, mapped, channel, thread_ts);

  } catch (error) {
    console.error("[App] Unhandled error:", error.message);
    await reply(channel, thread_ts, `❌ Something went wrong: ${error.message}`);
  }
});

// ─────────────────────────────────────────────
// 2. Button action handlers
// ─────────────────────────────────────────────
/**
 * Check if a Slack user is a workspace admin.
 */
async function isWorkspaceAdmin(userId) {
  const result = await app.client.users.info({ user: userId });
  return result.user?.is_admin === true || result.user?.is_owner === true;
}

/**
 * Update the settings message to show a permission denied notice.
 */
async function denyFormatChange(body) {
  await app.client.chat.update({
    channel: body.channel.id,
    ts:      body.message.ts,
    text:    "Asana Brain — Response Format Settings",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Response Format Settings*

🚫 Only Slack workspace admins can change the response format.

Ask your workspace admin to update this setting.`
        }
      }
    ]
  });
}

app.action("set_format_bullets", async ({ body, ack }) => {
  await ack();
  const userId    = body.user.id;
  const channelId = body.actions[0].value;

  if (!await isWorkspaceAdmin(userId)) {
    await denyFormatChange(body);
    return;
  }

  setChannelFormat(channelId, "bullets");

  await app.client.chat.update({
    channel: body.channel.id,
    ts:      body.message.ts,
    text:    "Asana Brain — Response Format Settings",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Response Format Settings*

✅ Saved: *Bullet Points*

All answers in this channel will now use bullet points.`
        }
      }
    ]
  });
});

app.action("set_format_paragraphs", async ({ body, ack }) => {
  await ack();
  const userId    = body.user.id;
  const channelId = body.actions[0].value;

  if (!await isWorkspaceAdmin(userId)) {
    await denyFormatChange(body);
    return;
  }

  setChannelFormat(channelId, "paragraphs");

  await app.client.chat.update({
    channel: body.channel.id,
    ts:      body.message.ts,
    text:    "Asana Brain — Response Format Settings",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Response Format Settings*

✅ Saved: *Paragraphs*

All answers in this channel will now use paragraph format.`
        }
      }
    ]
  });
});

// ─────────────────────────────────────────────
// 3. Plain message handler
// ─────────────────────────────────────────────
app.event("message", async ({ event }) => {
  if (event.bot_id || event.subtype) return;
  if ((event.text || "").includes("<@")) return;

  const channel   = event.channel;
  const thread_ts = event.thread_ts || null;
  const text      = (event.text || "").trim();
  if (!text) return;

  // ── a) Waiting for GID after name lookup failure ──────────────────────────
  if (pendingGidChannels[channel]) {
    const replyThread = pendingGidChannels[channel];

    if (!/^\d+$/.test(text)) {
      await reply(channel, replyThread,
        `⚠️ That doesn't look like a numeric GID. Please reply with just the number — e.g. \`1214148499624609\``
      );
      return;
    }

    delete pendingGidChannels[channel];
    await reply(channel, replyThread, `🔍 Looking up GID *${text}*...`);

    try {
      const snapshot = await getCacheForProject(text);
      const realName = snapshot.project.name;
      setChannelProject(channel, realName, String(snapshot.project.gid));
      await reply(channel, replyThread,
        `✅ Reconnected to *${realName}*! You can keep asking questions.`
      );
    } catch (err) {
      pendingGidChannels[channel] = replyThread;
      await reply(channel, replyThread,
        `❌ Couldn't find a project with GID *${text}*. Please double-check and try again.`
      );
    }
    return;
  }

  // ── b) Waiting for project name ───────────────────────────────────────────
  if (pendingChannels[channel]) {
    const replyThread = pendingChannels[channel];
    delete pendingChannels[channel];
    await connectChannel(channel, replyThread, text);
    return;
  }

  // ── c) Channel is connected — answer the question ─────────────────────────
  const projectName = getChannelProject(channel);
  if (projectName) {
    console.log(`[App] Reply | channel: ${channel} | thread: ${thread_ts} | text: "${text}"`);
    await answerQuestion(text, projectName, channel, thread_ts);
    return;
  }
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function connectChannel(channel, thread_ts, projectName) {
  await reply(channel, thread_ts, `🔍 Looking up *${projectName}* in Asana...`);

  try {
    const snapshot = await getCacheForProject(projectName);
    const realName = snapshot.project.name;
    const gid      = String(snapshot.project.gid);

    setChannelProject(channel, realName, gid);

    await reply(channel, thread_ts,
      `✅ This channel is now connected to *${realName}*!\n\n` +
      `Ask me anything — tasks, overdue items, milestones, progress, team, sections.\n` +
      `_No need to mention me again — just ask away._\n` +
      `_Type \`@Asana Brain settings\` to change response format._\n` +
      `_Type \`@Asana Brain switch project\` to connect a different project._`
    );

  } catch (error) {
    pendingChannels[channel] = thread_ts;
    await reply(channel, thread_ts,
      `❌ I couldn't find *"${projectName}"* in Asana.\n\n` +
      `Try one of these:\n` +
      `• Different spelling — check it matches exactly in Asana\n` +
      `• The numeric Asana project GID — e.g. \`1214148499624609\`\n\n` +
      `_Find the GID in the Asana URL: \`app.asana.com/0/1214148499624609/list\`_`
    );
  }
}

async function answerQuestion(question, projectName, channel, thread_ts) {
  try {
    const format   = getChannelFormat(channel);
    const snapshot = await getCacheForProject(projectName);
    const answer   = await askBrain(question, snapshot, format);
    await reply(channel, thread_ts, answer);
  } catch (error) {
    console.error("[App] answerQuestion error:", error.message);
    pendingGidChannels[channel] = thread_ts;
    await reply(channel, thread_ts,
      `⚠️ I'm having trouble finding *"${projectName}"* in Asana.\n\n` +
      `Please reply with the numeric Asana project GID to reconnect.\n` +
      `_Find it in the Asana URL: \`app.asana.com/0/1214148499624609/list\`_`
    );
  }
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("✅ Asana Brain running — mention me in any channel to get started!");
})();
