import 'dotenv/config';
import { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import { CatalogLoader } from './build/catalog/catalog-loader.js';
import { ExecuteApiTool } from './build/tools/execute-api-tool.js';
import { ExploreCatalogTool } from './build/tools/explore-catalog-tool.js';
import { createAuthenticatorFromEnv } from './build/auth/sp-api-auth.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_SIMPLE        = 'claude-haiku-4-5-20251001';
const MODEL_COMPLEX       = 'claude-sonnet-4-6';
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
// Tool definitions for Anthropic API
// ---------------------------------------------------------------------------

const ANTHROPIC_TOOLS = [
  {
    name: 'execute-sp-api',
    description: 'Execute Amazon Selling Partner API requests with specified endpoint and parameters',
    input_schema: {
      type: 'object',
      properties: {
        endpoint:          { type: 'string',  description: 'The specific SP-API endpoint to use (required)' },
        parameters:        { type: 'object',  description: 'Complete set of API parameters' },
        method:            { type: 'string',  enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
        additionalHeaders: { type: 'object',  description: 'Additional request headers' },
        rawMode:           { type: 'boolean', description: 'Return raw response if true' },
        generateCode:      { type: 'boolean', description: 'Generate code snippet if true' },
        region:            { type: 'string',  description: 'AWS region for the request' },
      },
      required: ['endpoint', 'parameters'],
    },
  },
  {
    name: 'explore-sp-api-catalog',
    description: 'Get information about SP-API endpoints and parameters',
    input_schema: {
      type: 'object',
      properties: {
        endpoint:       { type: 'string',  description: 'Specific endpoint to get details for' },
        category:       { type: 'string',  description: 'Category to explore' },
        listEndpoints:  { type: 'boolean', description: 'List all available endpoints' },
        listCategories: { type: 'boolean', description: 'List all available categories' },
        depth:          { description: 'Depth of exploration (number or "full")' },
        ref:            { type: 'string',  description: 'Extract specific nested object using dot notation' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// SP-API tools (initialized at startup)
// ---------------------------------------------------------------------------

let executeTool = null;
let exploreTool = null;

async function initializeTools() {
  console.log('[Tools] Loading SP-API catalog...');
  const catalogLoader = new CatalogLoader();
  const catalog       = await catalogLoader.loadCatalog();
  const authenticator = createAuthenticatorFromEnv();
  executeTool = new ExecuteApiTool(catalog, authenticator);
  exploreTool = new ExploreCatalogTool(catalog);
  console.log('[Tools] SP-API tools initialized successfully');
}

async function callTool(toolName, toolInput) {
  if (toolName === 'execute-sp-api') {
    const result = await executeTool.execute(toolInput);
    return [{ type: 'text', text: result }];
  }
  if (toolName === 'explore-sp-api-catalog') {
    const result = await exploreTool.execute(toolInput);
    return [{ type: 'text', text: result }];
  }
  throw new Error(`Unknown tool: ${toolName}`);
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
// Agentic loop — Claude + direct tool calls
// ---------------------------------------------------------------------------

async function runAgenticLoop(model, userMessage) {
  const messages = [{ role: 'user', content: userMessage }];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: ANTHROPIC_TOOLS,
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
          toolContent = await callTool(block.name, block.input);
        } catch (err) {
          console.error(`[Tool] "${block.name}" failed:`, err.message);
          toolContent = [{ type: 'text', text: `Tool error: ${err.message}` }];
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent });
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
// Main request handler
// ---------------------------------------------------------------------------

async function handleUserMessage(userMessage) {
  const classification = await classifyMessage(userMessage);
  const model = classification === 'simple' ? MODEL_SIMPLE : MODEL_COMPLEX;
  console.log(`[${new Date().toISOString()}] Classification: "${classification}" → Model: ${model}`);
  return await runAgenticLoop(model, userMessage);
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
    await say({ text: `Sorry, I encountered an error: ${err.message}. Please try again.`, thread_ts: threadTs });
  }
});

// Direct messages
app.message(async ({ message, say }) => {
  if (message.channel_type !== 'im') return;
  if (message.subtype)                return;
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
// Startup
// ---------------------------------------------------------------------------

(async () => {
  console.log('[Slack Bot] Starting...');
  await initializeTools();
  await app.start();
  console.log('[Slack Bot] Running in Socket Mode ✓');
})();
