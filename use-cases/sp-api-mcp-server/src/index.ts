#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "./utils/logger.js";
import { CatalogLoader } from "./catalog/catalog-loader.js";
import { ExecuteApiTool } from "./tools/execute-api-tool.js";
import { ExploreCatalogTool, exploreCatalogSchema } from "./tools/explore-catalog-tool.js";
import { createAuthenticatorFromEnv } from "./auth/sp-api-auth.js";
import * as dotenv from 'dotenv';
import { z } from 'zod';
import http from 'http';
import { randomUUID } from 'node:crypto';
import { URL } from 'url';

dotenv.config();

function registerTools(server: McpServer, executeTool: ExecuteApiTool, exploreTool: ExploreCatalogTool) {
  server.tool(
    "execute-sp-api",
    "Execute Amazon Selling Partner API requests with specified endpoint and parameters",
    {
      endpoint: z.string().describe("The specific SP-API endpoint to use (required)"),
      parameters: z.record(z.any()).describe("Complete set of API parameters"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("HTTP method"),
      additionalHeaders: z.record(z.string()).optional().describe("Additional request headers"),
      rawMode: z.boolean().optional().default(false).describe("Return raw response if true"),
      generateCode: z.boolean().optional().default(false).describe("Generate code snippet if true"),
      region: z.string().optional().default("us-east-1").describe("AWS region for the request")
    },
    async (params) => {
      const result = await executeTool.execute(params);
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.tool(
    "explore-sp-api-catalog",
    "Get information about SP-API endpoints and parameters",
    exploreCatalogSchema.shape,
    async (params) => {
      const result = await exploreTool.execute(params);
      return { content: [{ type: "text", text: result }] };
    }
  );
}

async function main() {
  try {
    logger.info('Starting Amazon SP-API MCP Server...');

    const catalogLoader = new CatalogLoader();
    const catalog = await catalogLoader.loadCatalog();
    const authenticator = createAuthenticatorFromEnv();
    const executeTool = new ExecuteApiTool(catalog, authenticator);
    const exploreTool = new ExploreCatalogTool(catalog);

    const transportMode = process.env.MCP_TRANSPORT || 'http';

    if (transportMode === 'stdio') {
      const server = new McpServer({ name: "amazon-sp-api", version: "0.1.0" });
      registerTools(server, executeTool, exploreTool);
      const stdioTransport = new StdioServerTransport();
      await server.connect(stdioTransport);
      logger.info('Amazon SP-API MCP Server running on stdio');
      return;
    }

    // Streamable HTTP mode
    const port = parseInt(process.env.PORT || '3000');
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      const pathname = reqUrl.pathname;

      // Health check
      if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'amazon-sp-api-mcp' }));
        return;
      }

      if (pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'POST') {
          let transport: StreamableHTTPServerTransport;

          if (sessionId && sessions.has(sessionId)) {
            // Existing session
            transport = sessions.get(sessionId)!;
          } else if (!sessionId) {
            // New session — create server + transport
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, transport);
                logger.info(`Session initialized: ${id}`);
              },
              onsessionclosed: (id) => {
                sessions.delete(id);
                logger.info(`Session closed: ${id}`);
              },
            });
            const server = new McpServer({ name: "amazon-sp-api", version: "0.1.0" });
            registerTools(server, executeTool, exploreTool);
            await server.connect(transport);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
          }

          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === 'GET') {
          // SSE stream for server-to-client notifications
          if (!sessionId || !sessions.has(sessionId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Valid mcp-session-id header required' }));
            return;
          }
          await sessions.get(sessionId)!.handleRequest(req, res);
          return;
        }

        if (req.method === 'DELETE') {
          if (sessionId && sessions.has(sessionId)) {
            await sessions.get(sessionId)!.close();
            res.writeHead(200).end();
          } else {
            res.writeHead(404).end();
          }
          return;
        }
      }

      res.writeHead(404).end();
    });

    httpServer.listen(port, () => {
      logger.info(`Amazon SP-API MCP Server listening on port ${port} (Streamable HTTP)`);
      logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
    });

  } catch (error) {
    logger.error('Fatal error in main():', error);
    process.exit(1);
  }
}

main();
