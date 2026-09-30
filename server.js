require("dotenv").config();

const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const SAMPLE_RATE = 16_000;

if (!API_KEY) {
  console.error("Missing ASSEMBLYAI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const browserWss = new WebSocketServer({ server, path: "/ws" });

browserWss.on("connection", (browserWs) => {
  const params = new URLSearchParams({
    speech_model: "universal-3-5-pro",
    sample_rate: String(SAMPLE_RATE),
  });

  const assemblyWs = new WebSocket(
    `wss://streaming.assemblyai.com/v3/ws?${params}`,
    { headers: { Authorization: API_KEY } },
  );

  const audioQueue = [];
  let terminationRequested = false;
  let terminationReceived = false;

  const sendBrowserJson = (payload) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify(payload));
    }
  };

  assemblyWs.on("open", () => {
    for (const chunk of audioQueue.splice(0)) {
      assemblyWs.send(chunk, { binary: true });
    }

    if (terminationRequested) {
      assemblyWs.send(JSON.stringify({ type: "Terminate" }));
    }
  });

  assemblyWs.on("message", (message) => {
    let event;

    try {
      event = JSON.parse(message.toString());
    } catch {
      return;
    }

    sendBrowserJson(event);

    if (event.type === "Termination") {
      terminationReceived = true;
      browserWs.close(1000, "Transcription completed");
      assemblyWs.close();
    }
  });

  assemblyWs.on("error", (error) => {
    console.error("AssemblyAI WebSocket error:", error.message);
    sendBrowserJson({
      type: "ProxyError",
      message: "The transcription service connection failed.",
    });
  });

  assemblyWs.on("close", (code, reason) => {
    if (!terminationReceived) {
      sendBrowserJson({
        type: "ProxyClosed",
        code,
        message: reason.toString() || "The transcription service disconnected.",
      });
      browserWs.close();
    }
  });

  browserWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (assemblyWs.readyState === WebSocket.OPEN) {
        assemblyWs.send(data, { binary: true });
      } else if (assemblyWs.readyState === WebSocket.CONNECTING) {
        // Keep the initial audio while the upstream socket is connecting.
        // The cap prevents unbounded memory growth if AssemblyAI is unreachable.
        if (audioQueue.length < 100) audioQueue.push(Buffer.from(data));
      }
      return;
    }

    try {
      const command = JSON.parse(data.toString());
      if (command.type === "Terminate") {
        terminationRequested = true;
        if (assemblyWs.readyState === WebSocket.OPEN) {
          assemblyWs.send(JSON.stringify({ type: "Terminate" }));
        }
      }
    } catch {
      sendBrowserJson({ type: "ProxyError", message: "Invalid client message." });
    }
  });

  browserWs.on("close", () => {
    if (!terminationRequested && assemblyWs.readyState === WebSocket.OPEN) {
      terminationRequested = true;
      assemblyWs.send(JSON.stringify({ type: "Terminate" }));
    } else if (assemblyWs.readyState === WebSocket.CONNECTING) {
      assemblyWs.terminate();
    }
  });

  browserWs.on("error", (error) => {
    console.error("Browser WebSocket error:", error.message);
  });
});

server.listen(PORT, () => {
  console.log(`Live transcription app: http://localhost:${PORT}`);
});
