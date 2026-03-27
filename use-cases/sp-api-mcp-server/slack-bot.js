import 'dotenv/config';
import { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || `http://localhost:${process.env.PORT || '3000'}/mcp`;
const MODEL_SIMPLE   = 'claude-haiku-4-5-20251001';
const MODEL_COMPLEX  = 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = 10;

const SYSTEM_PROMPT = `You are an intelligent Amazon SP-API assistant integrated into Slack. You help Amazon sellers, developers, and internal teams interact with the Amazon Selling Partner API through natural conversation. You have access to SP-API tools covering 54 API categories and 346 endpoints including Orders, Inventory, Listings, Catalog, Reports, Finances, FBA, Notifications, and more.

Your behavior:
- Understand natural language requests and translate them into the correct SP-API actions
- Always confirm what action you are about to take before executing it
- Return results in clean, readable Slack-friendly format using bullet points and short summaries
- If a request is ambiguous, ask one clarifying question before proceeding
- If an API call fails, explain the error in plain English and suggest next steps

You always:
- Identify the correct marketplace when relevant
- Summarize large results instead of dumping raw data
- Flag destructive or irreversible actions before executing

You never:
- Hallucinate API responses
- Expose raw credentials or tokens
- Perform actions the user has not explicitly requested`;

const CLASSIFIER_PROMPT = `Classify the following user message into one of these categories:
- simple: basic lookups, single API calls, status checks, factual questions
- complex: multi-step workflows, comparisons, error diagnosis, bulk operations, anything needing reasoning

Reply with only one word: simple or complex

Message: `;

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// MCP client (lazy singleton with auto-reconnect)
// ---------------------------------------------------------------------------

let mcpClient = null;

async function getMcpClient() {
  if (mcpClient) return mcpClient;

  const client = new Client({ name: 'slack-bot-mcp-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
  await client.connect(transport);
  mcpClient = client;
  console.log(`[MCP] Connected to MCP server at ${MCP_SERVER_URL}`);
  return client;
}

async function resetMcpClient() {
  if (mcpClient) {
    try { await mcpClient.close(); } catch (_) {}
    mcpClient = null;
  }
}

async function getAnthropicTools() {
  const client = await getMcpClient();
  const { tools } = await client.listTools();
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema,
  }));
}

async function executeMcpTool(toolName, toolInput) {
  const client = await getMcpClient();
  const result = await client.callTool({ name: toolName, arguments: toolInput });
  return result.content; // already in Anthropic-compatible content block format
}

// ---------------------------------------------------------------------------
// Haiku router — classify then route to correct model
// ---------------------------------------------------------------------------

async function classifyMessage(userMessage) {
  const response = await anthropic.messages.create({
    model: MODEL_SIMPLE,
    max_tokens: 10,
    messages: [{ role: 'user', content: CLASSIFIER_PROMPT + userMessage }],
  });
  const text =
    response.content[0]?.type === 'text'
      ? response.content[0].text.trim().toLowerCase()
      : '';
  return text === 'simple' ? 'simple' : 'complex';
}

// ---------------------------------------------------------------------------
// Agentic loop — Claude + MCP tool calls
// ---------------------------------------------------------------------------

async function runAgenticLoop(model, userMessage) {
  const tools    = await getAnthropicTools();
  const messages = [{ role: 'user', content: userMessage }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text ?? 'Request completed with no text output.';
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let toolContent;
        try {
          toolContent = await executeMcpTool(block.name, block.input);
        } catch (err) {
          console.error(`[MCP] Tool "${block.name}" failed:`, err.message);
          toolContent = [{ type: 'text', text: `Tool error: ${err.message}` }];
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolContent,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text ?? `Stopped unexpectedly (reason: ${response.stop_reason}).`;
    }
  }

  return 'This request required too many steps. Try a more specific query.';
}

// ---------------------------------------------------------------------------
// Main request handler (classification → model selection → agentic loop)
// ---------------------------------------------------------------------------

async function handleUserMessage(userMessage) {
  const classification = await classifyMessage(userMessage);
  const model = classification === 'simple' ? MODEL_SIMPLE : MODEL_COMPLEX;
  console.log(
    `[${new Date().toISOString()}] Classification: "${classification}" → Model: ${model}`
  );

  try {
    return await runAgenticLoop(model, userMessage);
  } catch (err) {
    // Reset MCP client on connection errors so the next request reconnects
    if (err.code === 'ECONNREFUSED' || err.message?.toLowerCase().includes('connect')) {
      console.warn('[MCP] Connection error — resetting client for next request.');
      await resetMcpClient();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Slack app (Socket Mode)
// ---------------------------------------------------------------------------

const app = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode:    true,
  appToken:      process.env.SLACK_APP_TOKEN,
});

// @bot mention in channels / threads
app.event('app_mention', async ({ event, say }) => {
  const userMessage = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const threadTs    = event.thread_ts ?? event.ts;

  if (!userMessage) {
    await say({ text: 'Hi! How can I help you with the Amazon SP-API today?', thread_ts: threadTs });
    return;
  }

  await say({ text: '_Thinking..._', thread_ts: threadTs });

  try {
    const reply = await handleUserMessage(userMessage);
    await say({ text: reply, thread_ts: threadTs });
  } catch (err) {
    console.error('[Slack] Error handling mention:', err);
    await say({
      text: `Sorry, I encountered an error: ${err.message}. Please try again.`,
      thread_ts: threadTs,
    });
  }
});

// Direct messages
app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im') return; // only DMs
  if (message.subtype)                return; // skip edits, bot messages, etc.
  if (!message.text)                  return;

  await say('_Thinking..._');

  try {
    const reply = await handleUserMessage(message.text);
    await say(reply);
  } catch (err) {
    console.error('[Slack] Error handling DM:', err);
    await say(`Sorry, I encountered an error: ${err.message}. Please try again.`);
  }
});

// ---------------------------------------------------------------------------
// Startup — wait for MCP server, then start Slack
// ---------------------------------------------------------------------------

async function waitForMcpServer(maxRetries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await getMcpClient();
      return; // success
    } catch (err) {
      console.log(`[MCP] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  console.warn('[MCP] Could not connect to MCP server on startup — will retry on first request.');
  mcpClient = null;
}

(async () => {
  console.log('[Slack Bot] Starting...');
  console.log(`[Slack Bot] MCP server URL: ${MCP_SERVER_URL}`);

  await waitForMcpServer();

  await app.start();
  console.log('[Slack Bot] Running in Socket Mode ✓');
})();
